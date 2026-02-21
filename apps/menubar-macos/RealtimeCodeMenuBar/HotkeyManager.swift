import Cocoa
import Foundation

/// Recording activation mode.
enum RecordingMode {
    /// Press hotkey to start, press again to stop.
    case toggle
    /// Hold hotkey to record, release to stop and commit utterance.
    case pushToTalk
}

/// Manages a global hotkey for toggling recording.
///
/// Uses CGEvent tap when Accessibility permissions are available (required for push-to-talk
/// key-up detection), with a fallback to NSEvent global monitors for toggle mode.
final class HotkeyManager {
    /// The key code for 'R' (ANSI keyboard).
    private static let keyCodeR: CGKeyCode = 15

    /// Required modifier flags: Cmd + Shift.
    private static let requiredModifiers: CGEventFlags = [.maskCommand, .maskShift]

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var globalMonitor: Any?
    private var localMonitor: Any?

    private(set) var isListening = false
    private(set) var isKeyDown = false

    var mode: RecordingMode = .toggle

    /// Called when recording should be toggled (toggle mode) or started (push-to-talk).
    var onRecordingStart: (() -> Void)?

    /// Called when recording should stop (push-to-talk key release).
    /// In toggle mode, onRecordingStart handles both start and stop.
    var onRecordingStop: (() -> Void)?

    func startListening() {
        guard !isListening else { return }

        if setupEventTap() {
            isListening = true
            return
        }

        // Fallback: NSEvent monitors (toggle mode only — push-to-talk keyUp
        // may not be reliably delivered globally without CGEvent tap).
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
        isKeyDown = false
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
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo -> Unmanaged<CGEvent>? in
                guard let userInfo = userInfo else { return Unmanaged.passUnretained(event) }
                let manager = Unmanaged<HotkeyManager>.fromOpaque(userInfo).takeUnretainedValue()
                manager.handleCGEvent(type: type, event: event)
                return Unmanaged.passUnretained(event)
            },
            userInfo: userInfo
        ) else {
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        self.eventTap = tap
        self.runLoopSource = source
        return true
    }

    private func handleCGEvent(type: CGEventType, event: CGEvent) {
        let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        let flags = event.flags

        guard keyCode == Self.keyCodeR,
              flags.contains(Self.requiredModifiers) else { return }

        switch type {
        case .keyDown:
            guard !isKeyDown else { return } // Ignore key repeat
            isKeyDown = true
            DispatchQueue.main.async { [weak self] in
                self?.onRecordingStart?()
            }

        case .keyUp:
            guard isKeyDown else { return }
            isKeyDown = false
            if mode == .pushToTalk {
                DispatchQueue.main.async { [weak self] in
                    self?.onRecordingStop?()
                }
            }

        default:
            break
        }
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
        guard event.keyCode == Self.keyCodeR,
              event.modifierFlags.contains(.command),
              event.modifierFlags.contains(.shift) else { return }

        // NSEvent monitors only support toggle mode reliably
        DispatchQueue.main.async { [weak self] in
            self?.onRecordingStart?()
        }
    }
}
