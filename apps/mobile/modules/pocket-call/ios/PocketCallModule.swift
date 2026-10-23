import AVFoundation
import ExpoModulesCore
import Speech
import UIKit

/// The iOS call engine behind src/speech-engine.ts; the JS side of this interface is modules/pocket-call/index.ts.
public final class PocketCallModule: Module {
  private let engine = CallEngine()
  private let power = PowerMonitor()

  public func definition() -> ModuleDefinition {
    Name("PocketCall")

    Events("onCallEvent", "onPowerChange")

    OnCreate {
      engine.emit = { [weak self] event in
        self?.sendEvent("onCallEvent", event)
      }
      power.onChange = { [weak self] state in
        self?.sendEvent("onPowerChange", state)
      }
      power.start()
      // Long before the first call: CallKit refuses a call requested right after its provider was made.
      engine.prepareCallKit()
    }

    OnDestroy {
      engine.end()
      power.stop()
    }

    AsyncFunction("requestPermissions") { (promise: Promise) in
      CallPermissions.request { speech, microphone in
        promise.resolve(["speech": speech, "microphone": microphone])
      }
    }

    AsyncFunction("start") { (options: CallOptions, promise: Promise) in
      engine.start(options.config) { result in
        switch result {
        case .success(let info):
          promise.resolve(info)
        case .failure(let error):
          // ERR_CALL_LANGUAGE, ERR_CALL_MICROPHONE…: src/speech-engine.ts puts them in words.
          let code = (error as? CallError).map { "ERR_CALL_\($0.code.uppercased())" } ?? "ERR_CALL_START"
          promise.reject(code, error.localizedDescription)
        }
      }
    }

    Function("end") {
      engine.end()
    }

    Function("setMode") { (mode: String) in
      engine.setMode(CaptureMode(rawValue: mode) ?? .off)
    }

    Function("cancelCapture") {
      engine.cancelCapture()
    }

    Function("finishUtterance") {
      engine.finishUtterance()
    }

    Function("speak") { (id: String, text: String) in
      engine.speak(id: id, text: text)
    }

    Function("stopSpeaking") {
      engine.stopSpeaking()
    }

    Function("setThinking") { (on: Bool) in
      engine.setThinking(on)
    }

    Function("setMuted") { (muted: Bool) in
      engine.setMuted(muted)
    }

    Function("setSpeaker") { (on: Bool) in
      engine.setSpeaker(on)
    }

    AsyncFunction("getVoices") { (language: String) -> [[String: Any]] in
      CallVoices.list(language: language).map(CallVoices.describe)
    }

    Function("getPowerState") { () -> [String: Any] in
      power.state()
    }

    Function("preferredLanguages") { () -> [String] in
      Locale.preferredLanguages
    }

    // UIKit: read on the main thread.
    AsyncFunction("keyboardLanguages") { () -> [String] in
      MainActor.assumeIsolated {
        UITextInputMode.activeInputModes.compactMap { $0.primaryLanguage }
      }
    }.runOnQueue(.main)
  }
}

/// NativeCallOptions in index.ts.
struct CallOptions: Record {
  @Field var language: String = "ru-RU"
  @Field var voice: String? = nil
  @Field var rate: Double = 0.5
  @Field var callerName: String = "Claude"
  @Field var speaker: Bool = true
  @Field var useCallKit: Bool = true
  @Field var onDevice: Bool = true
  @Field var silenceMs: Double = 1100
  @Field var holdWords: [String] = []
  @Field var contextualStrings: [String] = []

  var config: CallConfig {
    CallConfig(
      language: language,
      voice: voice,
      rate: Float(rate),
      callerName: callerName,
      speaker: speaker,
      useCallKit: useCallKit,
      onDevice: onDevice,
      silenceMs: silenceMs,
      holdWords: holdWords,
      contextualStrings: contextualStrings
    )
  }
}

/// The microphone, then speech recognition: the two prompts a call needs.
enum CallPermissions {
  static func request(_ done: @escaping (_ speech: Bool, _ microphone: Bool) -> Void) {
    requestMicrophone { microphone in
      SFSpeechRecognizer.requestAuthorization { status in
        done(status == .authorized, microphone)
      }
    }
  }

  private static func requestMicrophone(_ done: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { granted in
        done(granted)
      }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { granted in
        done(granted)
      }
    }
  }
}
