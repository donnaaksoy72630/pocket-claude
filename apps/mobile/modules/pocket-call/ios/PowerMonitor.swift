import Foundation

/// Thermal state and Low Power Mode for `usePowerSaving` (src/power.ts), pushed to JS on every change.
final class PowerMonitor {
  var onChange: (([String: Any]) -> Void)?
  private var observers: [NSObjectProtocol] = []

  func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    let changed: (Notification) -> Void = { [weak self] _ in
      guard let self else { return }
      self.onChange?(self.state())
    }
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
