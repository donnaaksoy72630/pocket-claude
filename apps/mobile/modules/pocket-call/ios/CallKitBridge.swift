import AVFoundation
import CallKit

/**
 The call as iOS sees it: the call screen on the lock screen, the green pill or the Dynamic Island, mute and end from
 there and from AirPods, holds for a phone call. Outgoing only, started from the app, no push. CallKit activates the
 audio session itself, and the engine starts in didActivate. Every callback comes on the engine's queue.
 */
final class CallKitBridge: NSObject, CXProviderDelegate {
  var onActivate: () -> Void = {}
  var onDeactivate: () -> Void = {}
  /// Ended outside the app: the lock screen, a headset, a phone call answered with "End & Accept".
  var onEnded: () -> Void = {}
  var onMute: (Bool) -> Void = { _ in }
  var onHold: (Bool) -> Void = { _ in }
  var onLog: (String) -> Void = { _ in }

  private let provider: CXProvider
  private let controller: CXCallController
  private let createdAt = ProcessInfo.processInfo.systemUptime
  private var call: UUID?
  /// Every call this provider started, to end one CallKit still keeps.
  private var started: Set<UUID> = []
  private var name = ""
  private var connected = false

  var active: Bool { call != nil }
  /// Seconds since the provider was made: CXProvider registers with the system asynchronously.
  var age: TimeInterval { ProcessInfo.processInfo.systemUptime - createdAt }

  init(queue: DispatchQueue) {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = false
    // maximumCallGroups stays at its default (2), as in Apple's Speakerbox sample.
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false
    provider = CXProvider(configuration: configuration)
    controller = CXCallController(queue: queue)
    super.init()
    provider.setDelegate(self, queue: queue)
  }

  func start(name: String, completion: @escaping (Error?) -> Void) {
    let id = UUID()
    call = id
    started.insert(id)
    self.name = name
    connected = false
    let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: name))
    controller.request(CXTransaction(action: action)) { [weak self] error in
      if error != nil, self?.call == id { self?.call = nil }
      completion(error)
    }
  }

  func reportConnected() {
    guard let call, !connected else { return }
    connected = true
    provider.reportOutgoingCall(with: call, connectedAt: nil)
  }

  /// Hung up in the app.
  func end() {
    guard let id = call else { return }
    call = nil
    controller.request(CXTransaction(action: CXEndCallAction(call: id))) { [weak self] error in
      guard let self, let error else { return }
      self.onLog("CallKit could not end the call: \(error.localizedDescription)")
      self.provider.reportCall(with: id, endedAt: nil, reason: .remoteEnded)
    }
  }

  /// What CallKit has on the phone now, other apps' calls and phone calls included.
  func callsSummary() -> String {
    let calls = controller.callObserver.calls
    guard !calls.isEmpty else { return "CallKit sees no calls" }
    let list = calls.map { call -> String in
      var traits = [call.isOutgoing ? "outgoing" : "incoming"]
      if call.hasConnected { traits.append("connected") }
      if call.isOnHold { traits.append("on hold") }
      if call.hasEnded { traits.append("ended") }
      if started.contains(call.uuid) { traits.append(call.uuid == self.call ? "this call" : "an earlier call of Pocket") }
      return traits.joined(separator: " ")
    }
    return "CallKit sees \(calls.count) call(s): \(list.joined(separator: "; "))"
  }

  /// Ends calls of this provider that CallKit still keeps although Pocket is done with them.
  func endStaleCalls() {
    for stale in controller.callObserver.calls where started.contains(stale.uuid) && stale.uuid != call && !stale.hasEnded {
      onLog("ending a call CallKit still kept")
      provider.reportCall(with: stale.uuid, endedAt: nil, reason: .failed)
    }
  }

  /// A refused request, by name: "maximumCallGroupsReached (com.apple.CallKit.error.requesttransaction 7)".
  static func describe(_ error: NSError) -> String {
    guard error.domain == transactionErrors else { return "\(error.domain) \(error.code): \(error.localizedDescription)" }
    let names = [
      0: "unknown", 1: "unentitled", 2: "unknownCallProvider", 3: "emptyTransaction", 4: "unknownCallUUID",
      5: "callUUIDAlreadyExists", 6: "invalidAction", 7: "maximumCallGroupsReached", 8: "callIsProtected",
    ]
    return "\(names[error.code] ?? "code \(error.code)") (\(error.domain) \(error.code))"
  }

  /// Refusals seen when a request reaches the system before the provider's registration: asking again may pass.
  static func mayPassLater(_ error: NSError) -> Bool {
    error.domain == transactionErrors && (error.code == 7 || error.code == 2)
  }

  private static let transactionErrors = "com.apple.CallKit.error.requesttransaction"

  /// `fallback` runs when CallKit refuses, so that the mute still happens.
  func setMuted(_ muted: Bool, fallback: @escaping () -> Void) {
    guard let call else {
      fallback()
      return
    }
    controller.request(CXTransaction(action: CXSetMutedCallAction(call: call, muted: muted))) { error in
      if error != nil { fallback() }
    }
  }

  // MARK: - CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    guard call != nil else { return }
    call = nil
    onLog("CallKit reset")
    onEnded()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    let update = CXCallUpdate()
    update.remoteHandle = action.handle
    update.localizedCallerName = name
    update.hasVideo = false
    update.supportsHolding = true
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    provider.reportCall(with: action.callUUID, updated: update)
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    action.fulfill()
    // Hung up in the app: end() has let go of the call already.
    guard action.callUUID == call else { return }
    call = nil
    onEnded()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    onMute(action.isMuted)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    onHold(action.isOnHold)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    onActivate()
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    onDeactivate()
  }

  func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    onLog("CallKit timed out: \(type(of: action))")
  }
}
