import Cocoa
import Foundation

/// Supported global hotkey presets.
enum HotkeyPreset: String, CaseIterable, Identifiable {
    case commandShiftR
    case commandOptionR
    case controlOptionSpace

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .commandShiftR:
            return "Cmd+Shift+R"
        case .commandOptionR:
            return "Cmd+Option+R"
        case .controlOptionSpace:
            return "Ctrl+Option+Space"
        }
    }

    var keyCode: CGKeyCode {
        switch self {
        case .commandShiftR, .commandOptionR:
            return 15 // ANSI R
        case .controlOptionSpace:
            return 49 // Space
        }
    }

    var cgModifiers: CGEventFlags {
        switch self {
        case .commandShiftR:
            return [.maskCommand, .maskShift]
        case .commandOptionR:
            return [.maskCommand, .maskAlternate]
        case .controlOptionSpace:
            return [.maskControl, .maskAlternate]
        }
    }

    var nsModifiers: NSEvent.ModifierFlags {
        switch self {
        case .commandShiftR:
            return [.command, .shift]
        case .commandOptionR:
            return [.command, .option]
        case .controlOptionSpace:
            return [.control, .option]
        }
    }
}

/// Manages a global hotkey for recording toggle.
///
/// Uses CGEvent tap when Accessibility permissions are available,
/// with a fallback to NSEvent global monitors.
final class HotkeyManager {
    private static let defaultsKey = "RealtimeCodeMenuBar.hotkeyPreset"

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var globalMonitor: Any?
    private var localMonitor: Any?

    private(set) var isListening = false
    private(set) var preset: HotkeyPreset

    /// Called when the hotkey is pressed (toggle).
    var onToggle: (() -> Void)?

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.defaultsKey),
           let savedPreset = HotkeyPreset(rawValue: saved) {
            preset = savedPreset
        } else {
            preset = .commandShiftR
        }
    }

    func setPreset(_ newPreset: HotkeyPreset) {
        guard newPreset != preset else { return }
        preset = newPreset
        UserDefaults.standard.set(newPreset.rawValue, forKey: Self.defaultsKey)
        if isListening {
            stopListening()
            startListening()
        }
    }

    func startListening() {
        guard !isListening else { return }
        if setupEventTap() {
            isListening = true
            return
        }
        // Fallback: NSEvent monitors
        setupNSEventMonitors()
        isListening = true
    }

    func stopListening() {
        guard isListening else { return }

        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            if let source = runLoopSource {
                CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
            }
            runLoopSource = nil
            eventTap = nil
        }

        if let monitor = globalMonitor {
            NSEvent.removeMonitor(monitor)
            globalMonitor = nil
        }
        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }

        isListening = false
    }

    // MARK: - CGEvent Tap

    private func setupEventTap() -> Bool {
        let mask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue)

        let userInfo = Unmanaged.passUnretained(self).toOpaque()

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo -> Unmanaged<CGEvent>? in
                guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
                let manager = Unmanaged<HotkeyManager>.fromOpaque(userInfo).takeUnretainedValue()
                let consumed = manager.handleCGEvent(type: type, event: event)
                return consumed ? nil : Unmanaged.passUnretained(event)
            },
            userInfo: userInfo
        ) else {
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        eventTap = tap
        runLoopSource = source
        return true
    }

    private func handleCGEvent(type: CGEventType, event: CGEvent) -> Bool {
        let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        let flags = event.flags
        guard keyCode == preset.keyCode, flags.contains(preset.cgModifiers) else { return false }

        if type == .keyDown {
            // Ignore key repeat
            if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return true }
            DispatchQueue.main.async { [weak self] in
                self?.onToggle?()
            }
            return true
        }

        // Consume keyUp for our hotkey to prevent it reaching other apps
        if type == .keyUp { return true }

        return false
    }

    // MARK: - NSEvent Monitors (Fallback)

    private func setupNSEventMonitors() {
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) {
            [weak self] event in
            self?.handleNSEvent(event)
        }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
            [weak self] event in
            self?.handleNSEvent(event)
            return event
        }
    }

    private func handleNSEvent(_ event: NSEvent) {
        if event.isARepeat { return }
        guard event.keyCode == preset.keyCode else { return }
        guard event.modifierFlags.contains(preset.nsModifiers) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.onToggle?()
        }
    }
}
