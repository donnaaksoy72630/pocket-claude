import AVFoundation
import Accelerate
import Speech
import os

/// NativeCallOptions from modules/pocket-call/index.ts.
struct CallConfig {
  var language: String
  var voice: String?
  var rate: Float
  var callerName: String
  var speaker: Bool
  var useCallKit: Bool
  var onDevice: Bool
  var silenceMs: Double
  var holdWords: [String]
  var contextualStrings: [String]
}

/// `setMode` from JS: not listening, listening for the user, or watching for the user talking over the phone.
enum CaptureMode: String {
  case off, listen, watch
}

struct CallError: LocalizedError {
  let code: String
  let message: String
  var errorDescription: String? { message }
}

private let logger = os.Logger(subsystem: "dev.pocketclaude.app", category: "call")

private enum Tuning {
  /// Audio kept from before the voice was noticed, so the first word reaches the recognizer.
  static let prebuffer = 1.0
  /// Seconds of voice that count as speaking; longer while the phone talks (echo cancellation leaves a trace of it).
  static let attack = 0.15
  static let attackOverSpeech = 0.3
  /// Seconds of quiet that end speaking.
  static let hangover = 0.8
  /// A voice is this many dB over the noise floor and at least `minVoice` dBFS; `overSpeech` more while the phone talks.
  static let margin: Float = 14
  static let minVoice: Float = -50
  static let overSpeech: Float = 6
  /// The voice stopped and no words came for this long: it was noise.
  static let noWords = 2.5
  /// Apple ends a recognition request after about a minute.
  static let maxRequest = 50.0
  /// After endAudio(), how long the final transcript may take before the last partial one is used.
  static let finalWait = 0.6
  /// The reply's volume while the user talks over it.
  static let ducked: Float = 0.4
  /// The "thinking" chime plays at most this often.
  static let chimePeriod = 8.0
}

/**
 The audio of one call. A single AVAudioEngine with voice processing (echo and noise cancellation) runs from start
 to end and is not stopped between turns. A tap on its input feeds a level-based voice detector, a one-second
 prebuffer and, while someone talks, a speech recognition request. Replies are synthesized with
 AVSpeechSynthesizer.write and played by a player node of the same engine, so the user can talk over them.
 All state lives on `queue`.
 */
final class CallEngine: NSObject {
  /// Events for JS (`onCallEvent`), sent from the engine queue.
  var emit: ([String: Any]) -> Void = { _ in }

  private let queue = DispatchQueue(label: "dev.pocketclaude.call", qos: .userInitiated)
  private let recognitionQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "dev.pocketclaude.call.recognition"
    queue.maxConcurrentOperationCount = 1
    queue.qualityOfService = .userInitiated
    return queue
  }()

  private var config: CallConfig?
  private var running = false
  private var sessionActive = false
  private var mode: CaptureMode = .off
  private var muted = false
  private var held = false
  private var thinking = false
  private var observers: [NSObjectProtocol] = []
  /// The system call (lock screen, Dynamic Island); nil until the first call that uses it.
  private var bridge: CallKitBridge?
  /// CallKit activated the session, so CallKit deactivates it too.
  private var sessionByCallKit = false
  /// start() waits for the audio: at once without CallKit, until didActivate with it.
  private var pendingStart: ((Result<[String: Any], Error>) -> Void)?
  private var activationTimeout: DispatchWorkItem?
  /// The session as the app had it before the call, restored after it.
  private var savedSession: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?

  // The audio graph
  private var engine: AVAudioEngine?
  private var speechPlayer: AVAudioPlayerNode?
  private var chimePlayer: AVAudioPlayerNode?
  private var engineObserver: NSObjectProtocol?
  private var engineGeneration = 0
  private var echoCancellation = false
  /// Rebuilds in a row, each soon after the one before it, and when the last one happened.
  private var restartChain = 0
  private var rebuiltAt: TimeInterval = 0
  private var restartPending = false
  private var route = ""
  /// What the players take: mono float at the synthesizer's usual rate. The mixer converts it for the hardware.
  private let playerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 22050, channels: 1, interleaved: false)!
  private lazy var chime: AVAudioPCMBuffer? = makeChime()

  // Voice activity
  private var userSpeaking = false
  private var noiseFloor: Float = -60
  private var aboveFor = 0.0
  private var belowFor = 0.0
  private var lastVoiceAt: TimeInterval = 0
  private var prebuffer: [AVAudioPCMBuffer] = []
  private var prebufferSeconds = 0.0

  // Recognition
  private var recognizer: SFSpeechRecognizer?
  private var onDevice = false
  private var recognition: Recognition?
  private var recognitionToken = 0
  private var recognitionFailures = 0
  /// Requests in a row that the recognizer ended within a second, without a word.
  private var quickEnds = 0
  private var nextRecognitionAt: TimeInterval = 0
  /// The last utterance handed to JS and when the voice in it stopped: for the time to the reply's first sound.
  private var lastUtterance: (sent: TimeInterval, voiceEnded: TimeInterval)?

  // Speech
  private lazy var synthesizer: AVSpeechSynthesizer = {
    let synthesizer = AVSpeechSynthesizer()
    synthesizer.delegate = self
    return synthesizer
  }()
  private var voice: AVSpeechSynthesisVoice?
  private var spoken: [Spoken] = []
  private var synthesizing: Spoken?
  private var synthesisGeneration = 0
  private var playbackGeneration = 0
  private var converter: AVAudioConverter?
  private var watchdog: DispatchWorkItem?

  // MARK: - Called from JS

  func start(_ config: CallConfig, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async {
      if self.running { self.shutdown() }
      self.pendingStart = completion
      do {
        try self.begin(config)
      } catch {
        self.pendingStart = nil
        self.shutdown()
        completion(.failure(error))
      }
    }
  }

  func end() {
    queue.async {
      let wasRunning = self.running
      self.shutdown()
      if wasRunning { self.emit(["type": "state", "state": "ended", "reason": "local"]) }
    }
  }

  func setMode(_ next: CaptureMode) {
    queue.async { self.apply(next) }
  }

  func cancelCapture() {
    queue.async { self.dropRecognition() }
  }

  func finishUtterance() {
    queue.async { self.commit() }
  }

  func speak(id: String, text: String) {
    queue.async { self.enqueue(id: id, text: text) }
  }

  func stopSpeaking() {
    queue.async { self.stopSpeech() }
  }

  func setThinking(_ on: Bool) {
    queue.async {
      self.thinking = on
      self.updateChime()
    }
  }

  func setMuted(_ on: Bool) {
    queue.async {
      guard let bridge = self.bridge, bridge.active else {
        self.mute(on)
        return
      }
      // Through CallKit, so that the system call screen shows it too; the action comes back as onMute.
      bridge.setMuted(on) { [weak self] in self?.mute(on) }
    }
  }

  func setSpeaker(_ on: Bool) {
    queue.async { self.useSpeaker(on) }
  }

  // MARK: - Call lifecycle

  private func begin(_ config: CallConfig) throws {
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: config.language)) else {
      throw CallError(code: "language", message: "Speech recognition does not support \(config.language) on this iPhone.")
    }
    recognizer.queue = recognitionQueue
    recognizer.delegate = self
    recognizer.defaultTaskHint = .dictation
    self.recognizer = recognizer
    self.config = config
    onDevice = config.onDevice && recognizer.supportsOnDeviceRecognition
    voice = CallVoices.best(language: config.language, chosen: config.voice)
    recognitionFailures = 0
    quickEnds = 0
    nextRecognitionAt = 0
    restartChain = 0
    rebuiltAt = 0
    let session = AVAudioSession.sharedInstance()
    savedSession = (session.category, session.mode, session.categoryOptions)
    do {
      try configureSession(speaker: config.speaker)
    } catch {
      throw CallError(code: "audio", message: "Could not start the call audio: \(error.localizedDescription)")
    }
    running = true
    observeSession()
    guard config.useCallKit else {
      try activateAudio(byCallKit: false)
      return
    }
    // CallKit activates the session and calls didActivate, where the engine starts.
    callKit().start(name: config.callerName) { [weak self] error in
      self?.callKitStarted(error)
    }
    let timeout = DispatchWorkItem { [weak self] in
      self?.activationTimedOut()
    }
    activationTimeout = timeout
    queue.asyncAfter(deadline: .now() + 4, execute: timeout)
  }

  /// The session is on, activated by CallKit or by us: the engine starts and the call is on.
  private func activateAudio(byCallKit: Bool) throws {
    activationTimeout?.cancel()
    activationTimeout = nil
    if !byCallKit {
      do {
        try AVAudioSession.sharedInstance().setActive(true)
      } catch {
        throw CallError(code: "audio", message: "Could not start the call audio: \(error.localizedDescription)")
      }
    }
    sessionActive = true
    sessionByCallKit = byCallKit
    try buildEngine()
    // Sentences JS sent while the call was starting.
    synthesizeNext()
    route = currentRoute()
    emit(["type": "state", "state": "active"])
    emit(["type": "route", "output": route])
    let format = engine?.inputNode.outputFormat(forBus: 0)
    let callKitOn = bridge?.active == true
    note(
      "audio \(Int(format?.sampleRate ?? 0)) Hz, echo cancellation \(echoCancellation), "
        + "recognition \(onDevice ? "on device" : "online"), voice \(voice?.name ?? "default"), route \(route), "
        + "CallKit \(callKitOn ? (byCallKit ? "on" : "on, audio started by the app") : "off")"
    )
    if let recognizer, !recognizer.isAvailable {
      emit(["type": "recognitionError", "code": "unavailable", "message": "Speech recognition is unavailable right now."])
    }
    bridge?.reportConnected()
    let pending = pendingStart
    pendingStart = nil
    pending?(.success([
      "echoCancellation": echoCancellation,
      "callKit": callKitOn,
      "onDevice": onDevice,
      "voice": orNull(voice?.identifier),
      "voiceName": orNull(voice?.name),
      "voiceQuality": orNull(voice.map(CallVoices.quality)),
    ]))
  }

  private func callKit() -> CallKitBridge {
    if let bridge { return bridge }
    let made = CallKitBridge(queue: queue)
    made.onActivate = { [weak self] in self?.callKitActivated() }
    made.onDeactivate = { [weak self] in self?.callKitDeactivated() }
    made.onEnded = { [weak self] in self?.endedOutside() }
    made.onMute = { [weak self] muted in self?.mute(muted) }
    made.onHold = { [weak self] on in self?.hold(on) }
    made.onLog = { [weak self] message in self?.note(message) }
    bridge = made
    return made
  }

  private func callKitStarted(_ error: Error?) {
    guard let error, running, engine == nil else { return }
    note("CallKit did not start the call (\(error.localizedDescription)), going on without it")
    startDirectly()
  }

  private func activationTimedOut() {
    guard running, engine == nil else { return }
    note("CallKit did not activate the audio in time, starting it from the app")
    startDirectly()
  }

  private func startDirectly() {
    do {
      try activateAudio(byCallKit: false)
    } catch {
      failStart(error)
    }
  }

  private func failStart(_ error: Error) {
    let pending = pendingStart
    pendingStart = nil
    let wasRunning = running
    shutdown()
    if let pending {
      pending(.failure(error))
    } else if wasRunning {
      emit(["type": "error", "code": "audio", "message": error.localizedDescription, "fatal": true])
    }
  }

  private func callKitActivated() {
    guard running else { return }
    if engine == nil {
      do {
        try activateAudio(byCallKit: true)
      } catch {
        failStart(error)
      }
    } else if engine?.isRunning != true {
      // Back from a hold or another call: the same engine starts again.
      sessionActive = true
      restartAudio("CallKit activated the audio")
    }
  }

  private func callKitDeactivated() {
    guard running, let engine else { return }
    note("CallKit deactivated the audio")
    endCapture()
    // What the players drop now is scheduled again when the audio is back.
    playbackGeneration += 1
    engine.stop()
  }

  /// A phone call came in and the user put this one on hold, or took it back.
  private func hold(_ on: Bool) {
    guard running, held != on else { return }
    held = on
    note(on ? "call on hold" : "call taken off hold")
    if on {
      endCapture()
      chimePlayer?.stop()
    } else {
      updateChime()
    }
    emit(["type": "state", "state": on ? "held" : "active"])
  }

  /// Ended from the lock screen, a headset or by another call.
  private func endedOutside() {
    guard running || pendingStart != nil else { return }
    note("call ended outside the app")
    let pending = pendingStart
    pendingStart = nil
    shutdown()
    pending?(.failure(CallError(code: "ended", message: "The call was ended.")))
    emit(["type": "state", "state": "ended", "reason": "remote"])
  }

  private func shutdown() {
    running = false
    activationTimeout?.cancel()
    activationTimeout = nil
    bridge?.end()
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers = []
    recognition?.task?.cancel()
    recognition = nil
    recognizer = nil
    synthesisGeneration += 1
    watchdog?.cancel()
    watchdog = nil
    if synthesizing != nil { synthesizer.stopSpeaking(at: .immediate) }
    synthesizing = nil
    spoken = []
    converter = nil
    teardownEngine()
    clearPrebuffer()
    userSpeaking = false
    mode = .off
    muted = false
    held = false
    thinking = false
    restartPending = false
    lastUtterance = nil
    config = nil
    let session = AVAudioSession.sharedInstance()
    // CallKit deactivates the session it activated.
    if sessionActive && !sessionByCallKit {
      do {
        try session.setActive(false, options: .notifyOthersOnDeactivation)
      } catch {
        logger.notice("audio session deactivation: \(error.localizedDescription, privacy: .public)")
      }
    }
    sessionActive = false
    sessionByCallKit = false
    if let saved = savedSession {
      savedSession = nil
      // Videos after the call get the session as it was, not the call's voice-chat setup.
      try? session.setCategory(saved.category, mode: saved.mode, options: saved.options)
    }
    if let pending = pendingStart {
      pendingStart = nil
      pending(.failure(CallError(code: "ended", message: "The call has ended.")))
    }
  }

  private func configureSession(speaker: Bool) throws {
    var options: AVAudioSession.CategoryOptions = [.allowBluetoothA2DP]
    #if compiler(>=6.2)
    options.insert(.allowBluetoothHFP)
    #else
    options.insert(.allowBluetooth)
    #endif
    if speaker { options.insert(.defaultToSpeaker) }
    try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: options)
  }

  private func buildEngine() throws {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    do {
      // Before any connection: it swaps the engine's I/O unit for the voice-processing one.
      try input.setVoiceProcessingEnabled(true)
    } catch {
      note("echo cancellation is off: \(error.localizedDescription)")
    }
    echoCancellation = input.isVoiceProcessingEnabled
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw CallError(code: "microphone", message: "The microphone is not available. Another app may be using it.")
    }
    let speech = AVAudioPlayerNode()
    let chime = AVAudioPlayerNode()
    engine.attach(speech)
    engine.attach(chime)
    engine.connect(speech, to: engine.mainMixerNode, format: playerFormat)
    engine.connect(chime, to: engine.mainMixerNode, format: playerFormat)
    engineGeneration += 1
    let generation = engineGeneration
    input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
      self?.tapped(buffer, generation: generation)
    }
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw CallError(code: "audio", message: "Could not start the call audio: \(error.localizedDescription)")
    }
    if echoCancellation && muted { input.isVoiceProcessingInputMuted = true }
    self.engine = engine
    speechPlayer = speech
    chimePlayer = chime
    speech.play()
    engineObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      self?.queue.async { self?.configurationChanged(generation) }
    }
    reschedule()
    updateChime()
    updateDucking()
  }

  private func teardownEngine() {
    if let engineObserver { NotificationCenter.default.removeObserver(engineObserver) }
    engineObserver = nil
    engineGeneration += 1
    playbackGeneration += 1
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    speechPlayer?.stop()
    chimePlayer?.stop()
    engine.stop()
    for node in [speechPlayer, chimePlayer].compactMap({ $0 }) {
      engine.detach(node)
    }
    self.engine = nil
    speechPlayer = nil
    chimePlayer = nil
  }

  private func configurationChanged(_ generation: Int) {
    guard running, !held, generation == engineGeneration else { return }
    // Turning voice processing on can post one of these for an engine that keeps running.
    if engine?.isRunning == true {
      reportRoute()
      return
    }
    scheduleRestart("audio configuration changed")
  }

  /// iOS stopped the engine to reconfigure the hardware: rebuild the graph, with growing pauses so that a change
  /// that keeps coming back cannot spin.
  private func scheduleRestart(_ reason: String) {
    guard !restartPending else { return }
    // The last rebuild ran for a while: this is a new change (a route, the speaker button), not a loop.
    if uptime() - rebuiltAt > 5 { restartChain = 0 }
    guard restartChain < 6 else {
      note("audio keeps reconfiguring, giving up (\(reason))")
      emit(["type": "error", "code": "audio", "message": "The call audio keeps failing. Hang up and call again.", "fatal": true])
      return
    }
    let delay = restartChain == 0 ? 0 : min(0.25 * pow(2, Double(restartChain - 1)), 4)
    restartChain += 1
    restartPending = true
    queue.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      self.restartPending = false
      guard self.running, !self.held else { return }
      self.restartAudio(reason)
    }
  }

  private func restartAudio(_ reason: String) {
    // The input format may change with the route: what was heard so far goes to JS.
    commit()
    clearPrebuffer()
    setUserSpeaking(false)
    // Apple's guidance for a configuration change: start the same engine again. Building a new one turns voice
    // processing on afresh, which reconfigures the hardware and stops it again — a loop that never hears anything.
    if let engine {
      engine.prepare()
      do {
        try engine.start()
        // What the players still held is scheduled again below, from the first sound not heard yet.
        playbackGeneration += 1
        speechPlayer?.stop()
        chimePlayer?.stop()
        speechPlayer?.play()
        rebuiltAt = uptime()
        noiseFloor = -60
        reportRoute()
        reschedule()
        updateChime()
        note("audio resumed (\(reason)), route \(route)")
        return
      } catch {
        note("audio resume failed, rebuilding: \(error.localizedDescription)")
      }
    }
    teardownEngine()
    do {
      try buildEngine()
    } catch {
      note("audio restart failed: \(error.localizedDescription)")
      emit(["type": "error", "code": "audio", "message": error.localizedDescription, "fatal": true])
      return
    }
    rebuiltAt = uptime()
    noiseFloor = -60
    reportRoute()
    note("audio restarted (\(reason)), route \(route)")
  }

  private func observeSession() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let type = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:))
        self?.queue.async { self?.interrupted(type) }
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] _ in
        self?.queue.async { self?.reportRoute() }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
        self?.queue.async { self?.mediaServicesReset() }
      },
    ]
  }

  private func interrupted(_ type: AVAudioSession.InterruptionType?) {
    guard running, let type else { return }
    // CallKit reports holds and the audio coming and going itself.
    if sessionByCallKit {
      note("audio interruption \(type == .began ? "began" : "ended") during a CallKit call")
      return
    }
    switch type {
    case .began:
      guard !held else { return }
      held = true
      endCapture()
      chimePlayer?.stop()
      note("audio interrupted")
      emit(["type": "state", "state": "held"])
    case .ended:
      guard held else { return }
      resume("interruption ended")
    @unknown default:
      break
    }
  }

  private func mediaServicesReset() {
    guard running, let config else { return }
    do {
      try configureSession(speaker: config.speaker)
    } catch {
      note("audio session reset: \(error.localizedDescription)")
    }
    resume("media services were reset")
  }

  private func resume(_ reason: String, attempt: Int = 0) {
    do {
      try AVAudioSession.sharedInstance().setActive(true)
    } catch {
      // Right after a phone call iOS may not hand the audio back yet.
      guard attempt < 5 else {
        note("could not resume audio: \(error.localizedDescription)")
        return
      }
      queue.asyncAfter(deadline: .now() + Double(attempt + 1)) { [weak self] in
        guard let self, self.running, self.held else { return }
        self.resume(reason, attempt: attempt + 1)
      }
      return
    }
    held = false
    restartAudio(reason)
    emit(["type": "state", "state": "active"])
  }

  // MARK: - Listening

  /// On the tap's thread: copy the buffer (the engine reuses it) and measure it, then hand both to the queue.
  private func tapped(_ buffer: AVAudioPCMBuffer, generation: Int) {
    guard buffer.frameLength > 0, let copy = buffer.duplicate() else { return }
    let level = buffer.level()
    queue.async { [weak self] in
      self?.captured(copy, level: level, generation: generation)
    }
  }

  private func captured(_ buffer: AVAudioPCMBuffer, level: Float, generation: Int) {
    guard running, generation == engineGeneration else { return }
    guard mode != .off, !muted, !held else {
      setUserSpeaking(false)
      clearPrebuffer()
      return
    }
    let now = uptime()
    let seconds = Double(buffer.frameLength) / buffer.format.sampleRate
    detectVoice(level: level, seconds: seconds, now: now)
    if let current = recognition, current.finishingSince == nil {
      current.request.append(buffer)
      checkEndpoint(current, now: now)
      return
    }
    keep(buffer, seconds: seconds)
    if let since = recognition?.finishingSince {
      if now - since >= Tuning.finalWait { commit() }
    } else if userSpeaking && now >= nextRecognitionAt {
      startRecognition(now: now, level: level)
    }
  }

  /// Voice by level over a noise floor that follows quiet at once and steady noise slowly (about 1 dB/s).
  private func detectVoice(level: Float, seconds: Double, now: TimeInterval) {
    if level < noiseFloor {
      noiseFloor = level
    } else {
      noiseFloor += min(level - noiseFloor, 10) * Float(seconds) * 0.1
    }
    noiseFloor = min(max(noiseFloor, -90), -35)
    let overSpeech = !spoken.isEmpty
    let threshold = max(noiseFloor + Tuning.margin, Tuning.minVoice) + (overSpeech ? Tuning.overSpeech : 0)
    if level >= threshold {
      aboveFor += seconds
      belowFor = 0
      lastVoiceAt = now
    } else {
      belowFor += seconds
      aboveFor = 0
    }
    if !userSpeaking && aboveFor >= (overSpeech ? Tuning.attackOverSpeech : Tuning.attack) {
      setUserSpeaking(true)
    } else if userSpeaking && belowFor >= Tuning.hangover {
      setUserSpeaking(false)
    }
  }

  private func setUserSpeaking(_ on: Bool) {
    guard userSpeaking != on else { return }
    userSpeaking = on
    emit(["type": "vad", "speaking": on])
    updateDucking()
  }

  private func keep(_ buffer: AVAudioPCMBuffer, seconds: Double) {
    prebuffer.append(buffer)
    prebufferSeconds += seconds
    while prebufferSeconds > Tuning.prebuffer, prebuffer.count > 1 {
      let dropped = prebuffer.removeFirst()
      prebufferSeconds -= Double(dropped.frameLength) / dropped.format.sampleRate
    }
  }

  private func clearPrebuffer() {
    prebuffer.removeAll()
    prebufferSeconds = 0
  }

  private func startRecognition(now: TimeInterval, level: Float) {
    guard let recognizer, let config else { return }
    guard recognizer.isAvailable else {
      failRecognition(code: "unavailable", message: "Speech recognition is unavailable right now.", now: now)
      return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    request.requiresOnDeviceRecognition = onDevice
    request.addsPunctuation = true
    request.contextualStrings = config.contextualStrings
    recognitionToken += 1
    let token = recognitionToken
    let current = Recognition(token: token, request: request, startedAt: now)
    current.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      let text = result?.bestTranscription.formattedString
      let isFinal = result?.isFinal ?? false
      self?.queue.async {
        self?.recognized(token: token, text: text, isFinal: isFinal, error: error)
      }
    }
    recognition = current
    for buffer in prebuffer {
      request.append(buffer)
    }
    clearPrebuffer()
    emit(["type": "capture", "active": true])
    note("listening: voice \(Int(level)) dB, noise \(Int(noiseFloor)) dB")
  }

  private func recognized(token: Int, text: String?, isFinal: Bool, error: Error?) {
    guard let current = recognition, current.token == token else { return }
    let now = uptime()
    if let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text != current.heard {
      current.heard = text
      current.changedAt = now
      recognitionFailures = 0
      quickEnds = 0
      emit(["type": "partial", "text": text])
    }
    if (isFinal || error != nil) && current.heard.isEmpty && now - current.startedAt < 1 {
      endedAtOnce(now)
    }
    if isFinal || (error != nil && !current.heard.isEmpty) {
      commit()
    } else if let error {
      dropRecognition()
      recognitionFailed(error as NSError, now: now)
    }
  }

  /// The recognizer ended a request right after it began, without a word: each next request waits longer, so a
  /// recognizer that keeps doing that is not restarted on every buffer.
  private func endedAtOnce(_ now: TimeInterval) {
    quickEnds += 1
    nextRecognitionAt = max(nextRecognitionAt, now + min(0.5 * pow(2, Double(quickEnds - 1)), 8))
    if quickEnds == 4 { note("speech recognition keeps ending at once") }
  }

  /// The utterance is over: say when the pause is long enough for what was said, like endpointDelay in src/voice.ts.
  private func checkEndpoint(_ current: Recognition, now: TimeInterval) {
    let tooLong = now - current.startedAt >= Tuning.maxRequest
    if current.heard.isEmpty {
      if tooLong || (!userSpeaking && now - lastVoiceAt >= Tuning.noWords) {
        note("no words: noise \(Int(noiseFloor)) dB")
        dropRecognition()
      }
      return
    }
    let quiet = now - max(current.changedAt, lastVoiceAt)
    if tooLong || (!userSpeaking && quiet >= endpointDelay(current.heard)) {
      current.request.endAudio()
      current.finishingSince = now
    }
  }

  private func endpointDelay(_ text: String) -> TimeInterval {
    guard let config else { return 1.1 }
    var wait = config.silenceMs
    if let last = text.last, ".!?…".contains(last) { wait = min(wait, 700) }
    if let word = CallEngine.words(text).last, config.holdWords.contains(word) { wait += 700 }
    return wait / 1000
  }

  /// Lower-case words without punctuation, like words() in src/voice.ts.
  static func words(_ text: String) -> [String] {
    let separators = CharacterSet.whitespacesAndNewlines
      .union(CharacterSet(charactersIn: ".,!?;:…\"«»„“”()[]{}<>/\\|*_~`#+=@%^&$—–-"))
    return text.lowercased()
      .replacingOccurrences(of: "ё", with: "е")
      .replacingOccurrences(of: "’", with: "'")
      .components(separatedBy: separators)
      .filter { !$0.isEmpty }
  }

  /// Ends the request and hands JS what was heard.
  private func commit() {
    guard let current = recognition else { return }
    endRecognition()
    guard !current.heard.isEmpty else { return }
    lastUtterance = (sent: uptime(), voiceEnded: lastVoiceAt)
    emit(["type": "final", "text": current.heard])
  }

  private func endRecognition() {
    guard let current = recognition else { return }
    recognition = nil
    current.task?.cancel()
    emit(["type": "capture", "active": false])
  }

  /// Drops the request and the audio waiting for one: noise, or the phone's own voice.
  private func dropRecognition() {
    endRecognition()
    clearPrebuffer()
  }

  /// Listening stops: an utterance already waiting for its final transcript still goes to JS.
  private func endCapture() {
    if recognition?.finishingSince != nil { commit() } else { dropRecognition() }
    setUserSpeaking(false)
    clearPrebuffer()
  }

  private func recognitionFailed(_ error: NSError, now: TimeInterval) {
    let code = error.code
    // Nothing was said (1110; 203 "Retry" over SiriSpeechErrorDomain 1), or the request was cancelled (216, 301).
    if error.domain == "kAFAssistantErrorDomain", code == 1110 || code == 216 { return }
    if error.domain == "kLSRErrorDomain", code == 301 { return }
    if error.domain == "kAFAssistantErrorDomain", code == 203,
      let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError,
      underlying.domain == "SiriSpeechErrorDomain", underlying.code == 1
    {
      return
    }
    if onDevice, error.domain == "kLSRErrorDomain", code == 102 || code == 201 || code == 300 {
      // The on-device model is missing or off; Apple's servers know the language too.
      onDevice = false
      note("on-device recognition failed (\(code)), using the online recognizer")
    }
    failRecognition(code: "\(error.domain):\(code)", message: error.localizedDescription, now: now)
  }

  /// Waits longer after each failure in a row, so a broken recognizer is not restarted on every word.
  private func failRecognition(code: String, message: String, now: TimeInterval) {
    recognitionFailures += 1
    nextRecognitionAt = max(nextRecognitionAt, now + min(0.5 * pow(2, Double(recognitionFailures - 1)), 8))
    emit(["type": "recognitionError", "code": code, "message": message])
    if recognitionFailures == 4 {
      emit(["type": "error", "code": "recognition", "message": "Speech recognition keeps failing: \(message)", "fatal": false])
    }
  }

  private func apply(_ next: CaptureMode) {
    guard next != mode else { return }
    mode = next
    if next == .off { endCapture() }
    updateDucking()
  }

  private func mute(_ on: Bool) {
    muted = on
    if echoCancellation, let engine { engine.inputNode.isVoiceProcessingInputMuted = on }
    if on { endCapture() }
    emit(["type": "muted", "muted": on])
  }

  // MARK: - Speaking

  private func enqueue(id: String, text: String) {
    spoken.append(Spoken(id: id, text: text))
    synthesizeNext()
    updateChime()
  }

  /// One sentence at a time: synthesis runs far ahead of playback, so the next one is ready before this one ends.
  private func synthesizeNext() {
    guard running, synthesizing == nil, let item = spoken.first(where: { !$0.synthesized }) else { return }
    let utterance = AVSpeechUtterance(string: item.text)
    utterance.voice = voice
    let rate = config?.rate ?? AVSpeechUtteranceDefaultSpeechRate
    utterance.rate = min(max(rate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    utterance.prefersAssistiveTechnologySettings = false
    item.utterance = utterance
    synthesizing = item
    converter = nil
    let generation = synthesisGeneration
    armWatchdog(for: item, after: 8)
    synthesizer.write(utterance) { [weak self] buffer in
      guard let pcm = buffer as? AVAudioPCMBuffer else { return }
      // The synthesizer may reuse the buffer once this returns. An empty one ends the sentence.
      let chunk = pcm.frameLength > 0 ? pcm.duplicate() : nil
      let done = pcm.frameLength == 0
      self?.queue.async {
        self?.synthesized(chunk, done: done, item: item, generation: generation)
      }
    }
  }

  private func synthesized(_ chunk: AVAudioPCMBuffer?, done: Bool, item: Spoken, generation: Int) {
    guard generation == synthesisGeneration, synthesizing === item else { return }
    if let chunk, let audio = convert(chunk) {
      item.pending.append(audio)
      schedule(audio, for: item)
      advance()
    }
    if done {
      finishSynthesis(item)
    } else {
      armWatchdog(for: item, after: 3)
    }
  }

  private func finishSynthesis(_ item: Spoken) {
    guard synthesizing === item else { return }
    watchdog?.cancel()
    watchdog = nil
    synthesizing = nil
    item.synthesized = true
    advance()
    synthesizeNext()
  }

  /// write() ends a sentence with an empty buffer, and the delegate hears of it too; should neither come, the
  /// sentences after it must not wait forever.
  private func armWatchdog(for item: Spoken, after seconds: Double) {
    watchdog?.cancel()
    let generation = synthesisGeneration
    let work = DispatchWorkItem { [weak self] in
      guard let self, generation == self.synthesisGeneration, self.synthesizing === item else { return }
      self.note("speech synthesis stalled")
      self.finishSynthesis(item)
    }
    watchdog = work
    queue.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  private func schedule(_ buffer: AVAudioPCMBuffer, for item: Spoken) {
    // Without a running engine the buffer stays pending; buildEngine() schedules it.
    guard let player = speechPlayer, engine?.isRunning == true else { return }
    let generation = playbackGeneration
    player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.queue.async {
        self?.played(buffer, item: item, generation: generation)
      }
    }
    if !player.isPlaying { player.play() }
  }

  private func played(_ buffer: AVAudioPCMBuffer, item: Spoken, generation: Int) {
    guard generation == playbackGeneration else { return }
    if let index = item.pending.firstIndex(where: { $0 === buffer }) {
      item.pending.remove(at: index)
    }
    advance()
  }

  /// A new graph: what was not played yet, in order.
  private func reschedule() {
    for item in spoken {
      for buffer in item.pending {
        schedule(buffer, for: item)
      }
    }
  }

  /// Reports sentences starting and ending as the player gets through them.
  private func advance() {
    guard running else { return }
    var ended = false
    while let head = spoken.first {
      if !head.started {
        guard head.synthesized || !head.pending.isEmpty else { break }
        head.started = true
        emit(["type": "speechStart", "id": head.id])
        if let utterance = lastUtterance {
          lastUtterance = nil
          let now = uptime()
          note("first sound \(Int((now - utterance.sent) * 1000)) ms after the utterance went out, \(Int((now - utterance.voiceEnded) * 1000)) ms after the voice stopped")
        }
      }
      guard head.synthesized, head.pending.isEmpty else { break }
      spoken.removeFirst()
      ended = true
      emit(["type": "speechEnd", "id": head.id, "interrupted": false])
    }
    if ended && spoken.isEmpty {
      emit(["type": "speechIdle"])
      updateDucking()
      updateChime()
    }
  }

  private func stopSpeech() {
    let head = spoken.first
    synthesisGeneration += 1
    playbackGeneration += 1
    watchdog?.cancel()
    watchdog = nil
    if synthesizing != nil { synthesizer.stopSpeaking(at: .immediate) }
    synthesizing = nil
    converter = nil
    spoken.removeAll()
    speechPlayer?.stop()
    if let head, head.started {
      emit(["type": "speechEnd", "id": head.id, "interrupted": true])
    }
    emit(["type": "speechIdle"])
    updateDucking()
    updateChime()
  }

  /// Synthesizer output in the players' format.
  private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    if buffer.format == playerFormat { return buffer }
    if converter == nil || converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: playerFormat)
    }
    guard let converter else { return nil }
    let ratio = playerFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
    guard let output = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: capacity) else { return nil }
    let source = OneShot(buffer)
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      guard let next = source.take() else {
        inputStatus.pointee = .noDataNow
        return nil
      }
      inputStatus.pointee = .haveData
      return next
    }
    guard status != .error, output.frameLength > 0 else { return nil }
    return output
  }

  // MARK: - Sounds and routes

  private func updateDucking() {
    speechPlayer?.volume = mode == .watch && userSpeaking && !spoken.isEmpty ? Tuning.ducked : 1
  }

  /// The soft "thinking" loop while Claude works and the phone is silent.
  private func updateChime() {
    guard let player = chimePlayer, engine?.isRunning == true else { return }
    let wanted = thinking && !held && spoken.isEmpty
    if wanted && !player.isPlaying, let chime {
      player.scheduleBuffer(chime, at: nil, options: .loops, completionHandler: nil)
      player.play()
    } else if !wanted && player.isPlaying {
      player.stop()
    }
  }

  /// Two quiet notes, then silence until the loop comes round.
  private func makeChime() -> AVAudioPCMBuffer? {
    let rate = playerFormat.sampleRate
    let frames = AVAudioFrameCount(rate * Tuning.chimePeriod)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: frames),
      let samples = buffer.floatChannelData?[0]
    else { return nil }
    buffer.frameLength = frames
    samples.initialize(repeating: 0, count: Int(frames))
    let length = Int(0.14 * rate)
    for (start, frequency) in [(0.0, 660.0), (0.17, 880.0)] {
      let first = Int(start * rate)
      for i in 0..<length {
        let envelope = sin(Double.pi * Double(i) / Double(length))
        samples[first + i] = Float(0.1 * envelope * sin(2 * Double.pi * frequency * Double(i) / rate))
      }
    }
    return buffer
  }

  private func useSpeaker(_ on: Bool) {
    guard running, var config else { return }
    config.speaker = on
    self.config = config
    do {
      try configureSession(speaker: on)
      try AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
    } catch {
      note("speaker \(on ? "on" : "off"): \(error.localizedDescription)")
    }
    reportRoute()
  }

  private func reportRoute() {
    guard running else { return }
    let next = currentRoute()
    guard next != route else { return }
    route = next
    emit(["type": "route", "output": next])
  }

  private func currentRoute() -> String {
    guard let port = AVAudioSession.sharedInstance().currentRoute.outputs.first?.portType else { return "none" }
    switch port {
    case .builtInSpeaker: return "speaker"
    case .builtInReceiver: return "receiver"
    case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: return "bluetooth"
    case .headphones: return "headphones"
    case .carAudio: return "car"
    case .airPlay: return "airplay"
    case .usbAudio: return "usb"
    default: return port.rawValue
    }
  }

  // MARK: - Helpers

  /// The call log in JS (VoiceCall.note) and the system log; a few lines per turn at most.
  private func note(_ message: String) {
    logger.notice("\(message, privacy: .public)")
    emit(["type": "log", "message": message])
  }

  private func uptime() -> TimeInterval {
    ProcessInfo.processInfo.systemUptime
  }
}

extension CallEngine: AVSpeechSynthesizerDelegate {
  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    // The empty buffer has usually ended the sentence by now; this covers a write() that never sends one.
    queue.asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self, let item = self.synthesizing, item.utterance === utterance else { return }
      self.finishSynthesis(item)
    }
  }
}

extension CallEngine: SFSpeechRecognizerDelegate {
  func speechRecognizer(_ speechRecognizer: SFSpeechRecognizer, availabilityDidChange available: Bool) {
    queue.async { [weak self] in
      self?.note("speech recognition \(available ? "available" : "unavailable")")
    }
  }
}

/// One recognition request: from the first word of an utterance to its end.
private final class Recognition {
  let token: Int
  let request: SFSpeechAudioBufferRecognitionRequest
  let startedAt: TimeInterval
  var task: SFSpeechRecognitionTask?
  var heard = ""
  var changedAt: TimeInterval
  /// endAudio() was called: waiting for the final transcript.
  var finishingSince: TimeInterval?

  init(token: Int, request: SFSpeechAudioBufferRecognitionRequest, startedAt: TimeInterval) {
    self.token = token
    self.request = request
    self.startedAt = startedAt
    changedAt = startedAt
  }
}

/// One sentence to say, from synthesis to the end of playback.
private final class Spoken {
  let id: String
  let text: String
  var utterance: AVSpeechUtterance?
  /// Scheduled on the player and not heard yet, in order.
  var pending: [AVAudioPCMBuffer] = []
  var synthesized = false
  var started = false

  init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

/// Hands one buffer to AVAudioConverter, then reports that there is no more for now.
private final class OneShot {
  private var buffer: AVAudioPCMBuffer?

  init(_ buffer: AVAudioPCMBuffer) {
    self.buffer = buffer
  }

  func take() -> AVAudioPCMBuffer? {
    defer { buffer = nil }
    return buffer
  }
}

/// Installed voices: the best one for a language (Premium, then Enhanced, then the default) and their JS form.
enum CallVoices {
  static func list(language: String) -> [AVSpeechSynthesisVoice] {
    let wanted = language.replacingOccurrences(of: "_", with: "-").lowercased()
    let prefix = String(wanted.prefix(2))
    return AVSpeechSynthesisVoice.speechVoices()
      .filter { $0.language.lowercased().hasPrefix(prefix) && !isNovelty($0) }
      .sorted { lhs, rhs in
        let (a, b) = (score(lhs, wanted), score(rhs, wanted))
        return a != b ? a > b : lhs.name < rhs.name
      }
  }

  /// The voice picked in Settings when it speaks the call's language, else the best installed one.
  static func best(language: String, chosen: String?) -> AVSpeechSynthesisVoice? {
    let prefix = String(language.lowercased().prefix(2))
    if let chosen, let voice = AVSpeechSynthesisVoice(identifier: chosen), voice.language.lowercased().hasPrefix(prefix) {
      return voice
    }
    return list(language: language).first ?? AVSpeechSynthesisVoice(language: language)
  }

  static func quality(_ voice: AVSpeechSynthesisVoice) -> String {
    switch voice.quality {
    case .premium: return "premium"
    case .enhanced: return "enhanced"
    default: return "default"
    }
  }

  /// NativeVoice in index.ts.
  static func describe(_ voice: AVSpeechSynthesisVoice) -> [String: Any] {
    ["identifier": voice.identifier, "name": voice.name, "language": voice.language, "quality": quality(voice)]
  }

  private static func score(_ voice: AVSpeechSynthesisVoice, _ wanted: String) -> Int {
    let rank: Int
    switch voice.quality {
    case .premium: rank = 3
    case .enhanced: rank = 2
    default: rank = 1
    }
    return rank * 2 + (voice.language.lowercased() == wanted ? 1 : 0)
  }

  private static func isNovelty(_ voice: AVSpeechSynthesisVoice) -> Bool {
    if #available(iOS 17.0, *) {
      return voice.voiceTraits.contains(.isNoveltyVoice) || voice.voiceTraits.contains(.isPersonalVoice)
    }
    return false
  }
}

private func orNull(_ value: Any?) -> Any {
  value ?? NSNull()
}

private extension AVAudioPCMBuffer {
  /// A copy that outlives the callback that lent this buffer.
  func duplicate() -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else { return nil }
    copy.frameLength = frameLength
    let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: audioBufferList))
    let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for index in 0..<min(source.count, target.count) {
      guard let from = source[index].mData, let to = target[index].mData else { continue }
      memcpy(to, from, Int(min(source[index].mDataByteSize, target[index].mDataByteSize)))
    }
    return copy
  }

  /// Loudness of the first channel, in dBFS.
  func level() -> Float {
    guard let samples = floatChannelData?[0], frameLength > 0 else { return -120 }
    var rms: Float = 0
    vDSP_rmsqv(samples, 1, &rms, vDSP_Length(frameLength))
    return 20 * log10(max(rms, 0.000_001))
  }
}
