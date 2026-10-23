import Foundation
import os

private let logger = os.Logger(subsystem: "dev.pocketclaude.app", category: "power")

/// Thermal state and Low Power Mode for `usePowerSaving` (src/power.ts), pushed to JS on every change.
final class PowerMonitor {
  var onChange: (([String: Any]) -> Void)?
  private var observers: [NSObjectProtocol] = []

  func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let changed: (Notification) -> Void = { [weak self] _ in
      guard let self else { return }
      PowerMonitor.log("changed")
      self.onChange?(self.state())
    }
    PowerMonitor.log("at launch")
    observers = [
      center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil, using: changed),
      center.addObserver(forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: nil, using: changed),
    ]
  }

  func stop() {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers = []
  }

  /// In the system log next to the call's lines: when the phone got warm during a long call (rare, on change only).
  private static func log(_ when: String) {
    let info = ProcessInfo.processInfo
    let thermal = name(info.thermalState)
    let lowPower = info.isLowPowerModeEnabled ? "on" : "off"
    logger.notice("power \(when, privacy: .public): thermal state \(thermal, privacy: .public), Low Power Mode \(lowPower, privacy: .public)")
  }

  /// PowerState in index.ts.
  func state() -> [String: Any] {
    let info = ProcessInfo.processInfo
    return ["thermalState": PowerMonitor.name(info.thermalState), "lowPower": info.isLowPowerModeEnabled]
  }

  static func name(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "nominal"
    }
  }
}
