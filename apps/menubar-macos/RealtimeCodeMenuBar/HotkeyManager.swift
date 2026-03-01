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

/// An arbitrary key + modifier combination recorded by the user.
struct CustomHotkey: Equatable {
    let keyCode: CGKeyCode
    let modifiers: NSEvent.ModifierFlags

    /// Modifier flags relevant for hotkey matching (ignoring caps lock, function, etc.).
    private static let relevantModifiers: NSEvent.ModifierFlags = [.command, .shift, .option, .control]

    var normalizedModifiers: NSEvent.ModifierFlags {
        modifiers.intersection(Self.relevantModifiers)
    }

    var cgModifiers: CGEventFlags {
        var flags = CGEventFlags()
        if modifiers.contains(.command) { flags.insert(.maskCommand) }
        if modifiers.contains(.shift) { flags.insert(.maskShift) }
        if modifiers.contains(.option) { flags.insert(.maskAlternate) }
        if modifiers.contains(.control) { flags.insert(.maskControl) }
        return flags
    }

    var displayName: String {
        var parts: [String] = []
        if modifiers.contains(.control) { parts.append("Ctrl") }
        if modifiers.contains(.option) { parts.append("Option") }
        if modifiers.contains(.shift) { parts.append("Shift") }
        if modifiers.contains(.command) { parts.append("Cmd") }
        parts.append(Self.keyName(for: keyCode))
        return parts.joined(separator: "+")
    }

    /// Human-readable name for a key code.
    static func keyName(for keyCode: CGKeyCode) -> String {
        switch keyCode {
        case 0: return "A"
        case 1: return "S"
        case 2: return "D"
        case 3: return "F"
        case 4: return "H"
        case 5: return "G"
        case 6: return "Z"
        case 7: return "X"
        case 8: return "C"
        case 9: return "V"
        case 11: return "B"
        case 12: return "Q"
        case 13: return "W"
        case 14: return "E"
        case 15: return "R"
        case 16: return "Y"
        case 17: return "T"
        case 18: return "1"
        case 19: return "2"
        case 20: return "3"
        case 21: return "4"
        case 22: return "6"
        case 23: return "5"
        case 24: return "="
        case 25: return "9"
        case 26: return "7"
        case 27: return "-"
        case 28: return "8"
        case 29: return "0"
        case 30: return "]"
        case 31: return "O"
        case 32: return "U"
        case 33: return "["
        case 34: return "I"
        case 35: return "P"
        case 36: return "Return"
        case 37: return "L"
        case 38: return "J"
        case 39: return "'"
        case 40: return "K"
        case 41: return ";"
        case 42: return "\\"
        case 43: return ","
        case 44: return "/"
        case 45: return "N"
        case 46: return "M"
        case 47: return "."
        case 48: return "Tab"
        case 49: return "Space"
        case 50: return "`"
        case 51: return "Delete"
        case 53: return "Escape"
        case 96: return "F5"
        case 97: return "F6"
        case 98: return "F7"
        case 99: return "F3"
        case 100: return "F8"
        case 101: return "F9"
        case 103: return "F11"
        case 105: return "F13"
        case 107: return "F14"
        case 109: return "F10"
        case 111: return "F12"
        case 113: return "F15"
        case 118: return "F4"
        case 120: return "F2"
        case 122: return "F1"
        case 123: return "Left"
        case 124: return "Right"
        case 125: return "Down"
        case 126: return "Up"
        default: return "Key\(keyCode)"
        }
    }

    // MARK: - Persistence

    private static let keyCodeKey = "RealtimeCodeMenuBar.customHotkey.keyCode"
    private static let modifiersKey = "RealtimeCodeMenuBar.customHotkey.modifiers"

    func save() {
        UserDefaults.standard.set(Int(keyCode), forKey: Self.keyCodeKey)
        UserDefaults.standard.set(Int(modifiers.rawValue), forKey: Self.modifiersKey)
    }

    static func load() -> CustomHotkey? {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: keyCodeKey) != nil else { return nil }
        let code = CGKeyCode(defaults.integer(forKey: keyCodeKey))
        let mods = NSEvent.ModifierFlags(rawValue: UInt(defaults.integer(forKey: modifiersKey)))
        return CustomHotkey(keyCode: code, modifiers: mods)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: keyCodeKey)
        UserDefaults.standard.removeObject(forKey: modifiersKey)
    }
}

/// Represents either a preset hotkey or a custom user-recorded hotkey.
enum HotkeyConfig: Equatable {
    case preset(HotkeyPreset)
    case custom(CustomHotkey)

    var keyCode: CGKeyCode {
        switch self {
        case .preset(let p): return p.keyCode
        case .custom(let c): return c.keyCode
        }
    }

    var cgModifiers: CGEventFlags {
        switch self {
        case .preset(let p): return p.cgModifiers
        case .custom(let c): return c.cgModifiers
        }
    }

    var nsModifiers: NSEvent.ModifierFlags {
        switch self {
        case .preset(let p): return p.nsModifiers
        case .custom(let c): return c.normalizedModifiers
        }
    }

    var displayName: String {
        switch self {
        case .preset(let p): return p.displayName
        case .custom(let c): return c.displayName
        }
    }
}

/// Manages a global hotkey for recording toggle.
///
/// Uses CGEvent tap when Accessibility permissions are available,
/// with a fallback to NSEvent global monitors.
final class HotkeyManager {
    private static let configTypeKey = "RealtimeCodeMenuBar.hotkeyConfigType"
    private static let presetKey = "RealtimeCodeMenuBar.hotkeyPreset"

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var globalMonitor: Any?
    private var localMonitor: Any?

    private(set) var isListening = false
    private(set) var config: HotkeyConfig

    /// Called when the hotkey is pressed (toggle).
    var onToggle: (() -> Void)?

    init() {
        let defaults = UserDefaults.standard
        let configType = defaults.string(forKey: Self.configTypeKey) ?? "preset"

        if configType == "custom", let custom = CustomHotkey.load() {
            config = .custom(custom)
        } else if let saved = defaults.string(forKey: Self.presetKey),
                  let savedPreset = HotkeyPreset(rawValue: saved) {
            config = .preset(savedPreset)
        } else {
            config = .preset(.commandShiftR)
        }
    }

    func setPreset(_ newPreset: HotkeyPreset) {
        let newConfig = HotkeyConfig.preset(newPreset)
        guard newConfig != config else { return }
        config = newConfig
        UserDefaults.standard.set("preset", forKey: Self.configTypeKey)
        UserDefaults.standard.set(newPreset.rawValue, forKey: Self.presetKey)
        CustomHotkey.clear()
        restartIfListening()
    }

    func setCustomHotkey(_ hotkey: CustomHotkey) {
        let newConfig = HotkeyConfig.custom(hotkey)
        guard newConfig != config else { return }
        config = newConfig
        UserDefaults.standard.set("custom", forKey: Self.configTypeKey)
        hotkey.save()
        restartIfListening()
    }

    private func restartIfListening() {
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
        guard keyCode == config.keyCode, flags.contains(config.cgModifiers) else { return false }

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
        guard event.keyCode == config.keyCode else { return }
        guard event.modifierFlags.contains(config.nsModifiers) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.onToggle?()
        }
    }
}
