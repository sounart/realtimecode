import SwiftUI
import Foundation
import AppKit

/// Observable app state shared across the menu bar UI.
@MainActor
final class AppState: ObservableObject {
    private static let workdirKey = "RealtimeCodeMenuBar.selectedWorkdir"

    @Published var isRecording = false
    @Published var isConnected = false
    @Published var statusText = "Ready"
    @Published var currentTranscript = ""
    @Published var isCodexWorking = false
    @Published var codexInstalledVersion: String?
    @Published var codexLatestVersion: String?
    @Published var codexUpdateAvailable = false
    @Published var codexUpdateDetail: String?
    @Published var isCheckingCodexUpdate = false
    @Published var isUpdatingCodex = false
    @Published private(set) var hasCheckedCodexUpdate = false
    @Published var selectedWorkdir: String
    @Published var hotkeyConfig: HotkeyConfig
    @Published var hotkeyEnabled = true

    let micService = MicCaptureService()
    let hotkeyManager = HotkeyManager()
    let orchestratorClient = OrchestratorClient()

    private var settingsWindow: NSWindow?

    private let defaultWorkdir = ProcessInfo.processInfo.environment["RTC_WORKDIR"]
        ?? FileManager.default.homeDirectoryForCurrentUser.path

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.workdirKey),
           FileManager.default.fileExists(atPath: saved) {
            self.selectedWorkdir = saved
        } else {
            self.selectedWorkdir = defaultWorkdir
        }
        self.hotkeyConfig = hotkeyManager.config
        setupMicService()
        setupHotkeyManager()
        setupOrchestratorClient()
        refreshCodexUpdateStatus()
    }

    // MARK: - Setup

    private func setupMicService() {
        micService.onAudioChunk = { [weak self] base64 in
            self?.orchestratorClient.streamAudio(base64Chunk: base64)
        }
    }

    private func setupHotkeyManager() {
        hotkeyManager.onToggle = { [weak self] in
            guard let self = self else { return }
            if self.isRecording {
                self.stopRecording()
            } else {
                self.startRecording()
            }
        }
        hotkeyManager.startListening()
        hotkeyEnabled = hotkeyManager.isListening
    }

    private func setupOrchestratorClient() {
        orchestratorClient.onEvent = { [weak self] event in
            guard let self = self else { return }
            switch event {
            case .status(let state):
                switch state {
                case "listening":
                    self.statusText = "Listening..."
                    self.isCodexWorking = false
                case "executing":
                    self.statusText = "Executing..."
                    self.isCodexWorking = true
                case "idle":
                    if self.isRecording {
                        self.micService.stopCapture()
                        self.isRecording = false
                        self.currentTranscript = ""
                    }
                    self.statusText = "Ready"
                    self.isCodexWorking = false
                default:
                    self.statusText = state.capitalized
                }

            case .transcript(let text, let isFinal):
                if isFinal {
                    self.currentTranscript = ""
                } else {
                    self.currentTranscript = text
                }

            case .codex(let type, _):
                switch type {
                case "tool_call", "file_change":
                    self.isCodexWorking = true
                case "done":
                    self.isCodexWorking = false
                    if self.statusText == "Executing..." {
                        self.statusText = "Listening..."
                    }
                default:
                    break
                }

            case .error(let message):
                if self.isRecording && self.isStartupConfigurationError(message) {
                    self.micService.stopCapture()
                    self.isRecording = false
                    self.currentTranscript = ""
                }
                self.isCodexWorking = false
                self.statusText = "Error: \(message)"
                print("[RealtimeCode] Error: \(message)")
            }
        }

        orchestratorClient.onDisconnect = { [weak self] in
            guard let self = self else { return }
            self.isConnected = false
            self.isCodexWorking = false
            self.statusText = "Disconnected"
            // Auto-reconnect if we were recording
            if self.isRecording {
                self.isRecording = false
                self.micService.stopCapture()
                self.reconnect()
            }
        }
    }

    private func isStartupConfigurationError(_ message: String) -> Bool {
        if message == "OPENAI_API_KEY not set" { return true }
        if message == "Missing workdir param" { return true }
        if message == "Invalid workdir" { return true }
        if message.hasPrefix("Unauthorized:") { return true }
        if message.lowercased().contains("not supported in realtime mode") { return true }
        if message.hasPrefix("Workdir ") { return true }
        return false
    }

    // MARK: - Actions

    func startRecording() {
        if !isConnected {
            connectAndStart()
            return
        }

        orchestratorClient.start(workdir: selectedWorkdir)
        beginMicCapture()
    }

    func stopRecording() {
        micService.stopCapture()
        isRecording = false
        isCodexWorking = false
        orchestratorClient.stop()
        statusText = "Ready"
        currentTranscript = ""
    }

    private func connectAndStart() {
        statusText = "Connecting..."
        orchestratorClient.connectWithSpawn(
            onConnected: { [weak self] in
                guard let self = self else { return }
                self.isConnected = true
                self.orchestratorClient.start(workdir: self.selectedWorkdir)
                self.beginMicCapture()
            },
            onFailure: { [weak self] message in
                self?.statusText = message
            }
        )
    }

    private func reconnect() {
        statusText = "Reconnecting..."
        orchestratorClient.connectWithSpawn(
            onConnected: { [weak self] in
                guard let self = self else { return }
                self.isConnected = true
                self.statusText = "Ready"
            },
            onFailure: { [weak self] _ in
                self?.statusText = "Reconnect failed"
            }
        )
    }

    private func beginMicCapture() {
        micService.requestPermission { [weak self] granted in
            guard let self = self, granted else {
                self?.statusText = "Mic permission denied"
                return
            }
            do {
                try self.micService.startCapture()
                self.isRecording = true
                self.statusText = "Listening..."
            } catch {
                self.statusText = "Mic error: \(error.localizedDescription)"
            }
        }
    }

    func chooseWorkdir() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Select"
        panel.message = "Choose working directory"
        panel.directoryURL = URL(fileURLWithPath: selectedWorkdir)

        if panel.runModal() == .OK, let url = panel.url {
            let wasRecording = isRecording
            if wasRecording { stopRecording() }
            selectedWorkdir = url.path
            UserDefaults.standard.set(selectedWorkdir, forKey: Self.workdirKey)
            if wasRecording { startRecording() }
        }
    }

    func setHotkeyPreset(_ preset: HotkeyPreset) {
        hotkeyManager.setPreset(preset)
        hotkeyConfig = hotkeyManager.config
    }

    func setCustomHotkey(_ hotkey: CustomHotkey) {
        hotkeyManager.setCustomHotkey(hotkey)
        hotkeyConfig = hotkeyManager.config
    }

    func toggleHotkeyListening() {
        if hotkeyEnabled {
            hotkeyManager.stopListening()
        } else {
            hotkeyManager.startListening()
        }
        hotkeyEnabled = hotkeyManager.isListening
    }

    func openSettings() {
        if let window = settingsWindow, window.isVisible {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let settingsView = SettingsView(appState: self)
        let hostingController = NSHostingController(rootView: settingsView)
        let window = NSWindow(contentViewController: hostingController)
        window.title = "RealtimeCode Settings"
        window.styleMask = [.titled, .closable]
        window.setContentSize(NSSize(width: 380, height: 260))
        window.center()
        window.isReleasedWhenClosed = false
        window.level = .floating

        settingsWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func quit() {
        if isRecording { stopRecording() }
        orchestratorClient.disconnect()
        hotkeyManager.stopListening()
        NSApplication.shared.terminate(nil)
    }

    func refreshCodexUpdateStatus() {
        if isCheckingCodexUpdate || isUpdatingCodex { return }
        isCheckingCodexUpdate = true
        codexUpdateDetail = nil

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let status = CodexUpdateService.checkStatus()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isCheckingCodexUpdate = false
                self.codexInstalledVersion = status.installedVersion
                self.codexLatestVersion = status.latestVersion
                self.codexUpdateAvailable = status.availability == .updateAvailable
                self.codexUpdateDetail = status.message
                self.hasCheckedCodexUpdate = true
            }
        }
    }

    func installOrUpdateCodex() {
        if isUpdatingCodex { return }
        isUpdatingCodex = true
        codexUpdateDetail = "Updating Codex CLI..."

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = CodexUpdateService.updateToLatest()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isUpdatingCodex = false
                self.codexUpdateDetail = result.message
                self.refreshCodexUpdateStatus()
            }
        }
    }

    var shouldShowCodexUpdateNotification: Bool {
        (hasCheckedCodexUpdate && (codexUpdateAvailable || codexInstalledVersion == nil)) || isUpdatingCodex
    }

    var codexUpdateHeadline: String {
        if isCheckingCodexUpdate {
            return "Checking Codex CLI..."
        }
        if isUpdatingCodex {
            return "Updating Codex CLI..."
        }
        if codexInstalledVersion == nil {
            return "Codex CLI not installed"
        }
        if codexUpdateAvailable {
            return "Codex update available"
        }
        return "Codex CLI"
    }

    var codexUpdateSummary: String {
        if let installed = codexInstalledVersion, let latest = codexLatestVersion, installed != latest {
            return "Installed \(installed) • Latest \(latest)"
        }
        if let installed = codexInstalledVersion {
            return "Installed \(installed)"
        }
        if let latest = codexLatestVersion {
            return "Latest \(latest)"
        }
        return "Install @openai/codex to run commands"
    }

    var codexUpdateButtonTitle: String {
        codexInstalledVersion == nil ? "Install Codex" : "Update Codex"
    }
}

// MARK: - App Entry Point

@main
struct RealtimeCodeMenuBarApp: App {
    @StateObject private var appState = AppState()

    init() {
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(appState: appState)
        } label: {
            Label {
                Text("RealtimeCode")
            } icon: {
                Image(systemName: menuBarIcon)
            }
        }
        .menuBarExtraStyle(.menu)
    }

    private var menuBarIcon: String {
        if appState.isCodexWorking {
            return "sparkles"
        } else if appState.isRecording {
            return "waveform"
        } else if appState.isConnected {
            return "chevron.left.forwardslash.chevron.right"
        } else {
            return "bolt.slash"
        }
    }
}

// MARK: - Settings View

struct SettingsView: View {
    @ObservedObject var appState: AppState
    @State private var isRecordingHotkey = false
    @State private var recordedHotkey: CustomHotkey?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Global Hotkey")
                .font(.headline)

            VStack(alignment: .leading, spacing: 8) {
                Text("Presets")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                ForEach(HotkeyPreset.allCases) { preset in
                    HStack {
                        Image(systemName: isPresetSelected(preset) ? "circle.inset.filled" : "circle")
                            .foregroundStyle(isPresetSelected(preset) ? Color.accentColor : Color.secondary)
                        Text(preset.displayName)
                        Spacer()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        appState.setHotkeyPreset(preset)
                        recordedHotkey = nil
                    }
                }
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text("Custom Shortcut")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                HotkeyRecorderView(
                    isRecording: $isRecordingHotkey,
                    currentConfig: appState.hotkeyConfig,
                    recordedHotkey: $recordedHotkey,
                    onRecord: { hotkey in
                        appState.setCustomHotkey(hotkey)
                    },
                    onClear: {
                        appState.setHotkeyPreset(.commandShiftR)
                    }
                )
            }

            Divider()

            Toggle(isOn: Binding(
                get: { appState.hotkeyEnabled },
                set: { _ in appState.toggleHotkeyListening() }
            )) {
                Text("Enable global hotkey")
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 380, height: 260)
    }

    private func isPresetSelected(_ preset: HotkeyPreset) -> Bool {
        if case .preset(let current) = appState.hotkeyConfig {
            return current == preset
        }
        return false
    }
}

/// A press-to-record hotkey field that captures arbitrary key + modifier combos.
struct HotkeyRecorderView: NSViewRepresentable {
    @Binding var isRecording: Bool
    let currentConfig: HotkeyConfig
    @Binding var recordedHotkey: CustomHotkey?
    let onRecord: (CustomHotkey) -> Void
    let onClear: () -> Void

    func makeNSView(context: Context) -> HotkeyRecorderNSView {
        let view = HotkeyRecorderNSView()
        view.onHotkeyRecorded = { hotkey in
            DispatchQueue.main.async {
                recordedHotkey = hotkey
                isRecording = false
                onRecord(hotkey)
            }
        }
        view.onRecordingChanged = { recording in
            DispatchQueue.main.async {
                isRecording = recording
            }
        }
        view.onClearPressed = {
            DispatchQueue.main.async {
                recordedHotkey = nil
                isRecording = false
                onClear()
            }
        }
        view.updateDisplay(config: currentConfig, isRecording: false)
        return view
    }

    func updateNSView(_ nsView: HotkeyRecorderNSView, context: Context) {
        nsView.updateDisplay(config: currentConfig, isRecording: isRecording)
    }
}

/// AppKit view that handles key event capture for hotkey recording.
final class HotkeyRecorderNSView: NSView {
    var onHotkeyRecorded: ((CustomHotkey) -> Void)?
    var onRecordingChanged: ((Bool) -> Void)?
    var onClearPressed: (() -> Void)?

    private var recording = false
    private let label = NSTextField(labelWithString: "")
    private let recordButton = NSButton()

    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: NSRect(x: 0, y: 0, width: 340, height: 28))
        setupViews()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupViews()
    }

    private func setupViews() {
        label.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false

        recordButton.title = "Record"
        recordButton.bezelStyle = .rounded
        recordButton.controlSize = .small
        recordButton.target = self
        recordButton.action = #selector(toggleRecording)
        recordButton.translatesAutoresizingMaskIntoConstraints = false

        let clearButton = NSButton()
        clearButton.title = "Clear"
        clearButton.bezelStyle = .rounded
        clearButton.controlSize = .small
        clearButton.target = self
        clearButton.action = #selector(clearHotkey)
        clearButton.translatesAutoresizingMaskIntoConstraints = false

        addSubview(label)
        addSubview(recordButton)
        addSubview(clearButton)

        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),

            clearButton.trailingAnchor.constraint(equalTo: trailingAnchor),
            clearButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            clearButton.widthAnchor.constraint(equalToConstant: 50),

            recordButton.trailingAnchor.constraint(equalTo: clearButton.leadingAnchor, constant: -4),
            recordButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            recordButton.widthAnchor.constraint(equalToConstant: 60),

            label.trailingAnchor.constraint(lessThanOrEqualTo: recordButton.leadingAnchor, constant: -8),

            heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    func updateDisplay(config: HotkeyConfig, isRecording: Bool) {
        if isRecording {
            label.stringValue = "Press a key combo..."
            label.textColor = .systemOrange
            recordButton.title = "Cancel"
        } else {
            if case .custom = config {
                label.stringValue = config.displayName
                label.textColor = .labelColor
            } else {
                label.stringValue = "Click Record to set custom hotkey"
                label.textColor = .secondaryLabelColor
            }
            recordButton.title = "Record"
        }
    }

    @objc private func toggleRecording() {
        recording.toggle()
        onRecordingChanged?(recording)
        if recording {
            window?.makeFirstResponder(self)
        }
    }

    @objc private func clearHotkey() {
        recording = false
        onRecordingChanged?(false)
        onClearPressed?()
    }

    override func keyDown(with event: NSEvent) {
        guard recording else {
            super.keyDown(with: event)
            return
        }

        let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])

        // Require at least one modifier
        guard !modifiers.isEmpty else { return }

        // Ignore bare modifier presses (key codes 54-59, 63 are modifier keys)
        let modifierKeyCodes: Set<UInt16> = [54, 55, 56, 57, 58, 59, 63]
        guard !modifierKeyCodes.contains(event.keyCode) else { return }

        let hotkey = CustomHotkey(keyCode: CGKeyCode(event.keyCode), modifiers: modifiers)
        recording = false
        onHotkeyRecorded?(hotkey)
    }

    override func flagsChanged(with event: NSEvent) {
        // Don't consume modifier-only events
        super.flagsChanged(with: event)
    }
}

// MARK: - Menu Content

struct MenuContent: View {
    @ObservedObject var appState: AppState

    var body: some View {
        HStack(spacing: 8) {
            statusIndicator

            VStack(alignment: .leading, spacing: 1) {
                Text(statusTitle)
                    .font(.headline)

                if let subtitle = statusSubtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            Text(connectionStatusTitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }

        if !appState.currentTranscript.isEmpty {
            infoRow(
                title: "Transcript",
                systemImage: "waveform",
                text: appState.currentTranscript,
                lineLimit: 3
            )
        }

        codexActivityRow

        if appState.shouldShowCodexUpdateNotification {
            codexUpdateNotificationRow
        }

        Divider()

        Button {
            if appState.isRecording {
                appState.stopRecording()
            } else {
                appState.startRecording()
            }
        } label: {
            Label(
                appState.isRecording ? "Stop Recording" : "Start Recording",
                systemImage: appState.isRecording ? "stop.circle.fill" : "mic.circle.fill"
            )
        }
        .keyboardShortcut("r")
        .disabled(isConnecting)

        Divider()

        Label {
            Text(displayWorkdir)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
        } icon: {
            Image(systemName: "folder")
                .foregroundStyle(.secondary)
        }
        .help(appState.selectedWorkdir)

        Button {
            appState.chooseWorkdir()
        } label: {
            Label("Choose Directory...", systemImage: "folder.badge.gearshape")
        }

        Button {
            revealWorkdirInFinder()
        } label: {
            Label("Reveal in Finder", systemImage: "arrow.up.forward.app")
        }
        .disabled(!canRevealWorkdir)

        Divider()

        Label {
            Text(appState.hotkeyConfig.displayName)
                .font(.caption2)
        } icon: {
            Image(systemName: "keyboard")
                .foregroundStyle(.secondary)
        }

        Button {
            appState.openSettings()
        } label: {
            Label("Hotkey Settings...", systemImage: "gearshape")
        }

        Button {
            appState.toggleHotkeyListening()
        } label: {
            Label(
                appState.hotkeyEnabled ? "Disable Hotkey" : "Enable Hotkey",
                systemImage: appState.hotkeyEnabled ? "bolt.slash.fill" : "bolt.fill"
            )
        }

        Divider()

        Button(role: .destructive) {
            appState.quit()
        } label: {
            Label("Quit RealtimeCode", systemImage: "power")
        }
        .keyboardShortcut("q")
    }

    private enum StatusSummary {
        case ready
        case connected
        case connecting
        case listening
        case executing
        case disconnected
        case error(String)
    }

    private var summary: StatusSummary {
        if appState.statusText.hasPrefix("Error:") {
            let message = appState.statusText
                .replacingOccurrences(of: "Error:", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return .error(message)
        }

        if appState.statusText == "Connecting..." || appState.statusText == "Reconnecting..." {
            return .connecting
        }

        if appState.statusText == "Disconnected" {
            return .disconnected
        }

        if appState.statusText == "Executing..." {
            return .executing
        }

        if appState.isRecording || appState.statusText == "Listening..." {
            return .listening
        }

        if appState.isConnected {
            return .connected
        }

        return .ready
    }

    private var isConnecting: Bool {
        if case .connecting = summary { return true }
        return false
    }

    private var statusTitle: String {
        switch summary {
        case .ready:
            return "Ready"
        case .connected:
            return "Connected"
        case .connecting:
            return "Connecting"
        case .listening:
            return "Listening"
        case .executing:
            return "Executing"
        case .disconnected:
            return "Disconnected"
        case .error:
            return "Error"
        }
    }

    private var statusSubtitle: String? {
        switch summary {
        case .error(let message):
            return message.isEmpty ? nil : message
        case .connecting:
            return "Starting services"
        case .executing:
            return "Running your request"
        case .disconnected:
            return "Reconnects on next start"
        default:
            return nil
        }
    }

    private var connectionStatusTitle: String {
        if case .connecting = summary {
            return "Starting"
        }
        return appState.isConnected ? "Online" : "Offline"
    }

    private var codexActivityColor: Color {
        appState.isCodexWorking ? .orange : .secondary
    }

    private var codexActivityRow: some View {
        HStack(spacing: 8) {
            codexActivityIndicator
            Text(appState.isCodexWorking ? "Codex is working" : "Codex is idle")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var codexUpdateNotificationRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: codexUpdateIconName)
                    .foregroundStyle(codexUpdateColor)
                Text(appState.codexUpdateHeadline)
                    .font(.caption)
                    .fontWeight(.semibold)
                Spacer()
                if appState.isCheckingCodexUpdate || appState.isUpdatingCodex {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            Text(appState.codexUpdateSummary)
                .font(.caption2)
                .foregroundStyle(.secondary)

            if let detail = appState.codexUpdateDetail, !detail.isEmpty {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 8) {
                Button(appState.codexUpdateButtonTitle) {
                    appState.installOrUpdateCodex()
                }
                .disabled(appState.isUpdatingCodex)

                Button("Check Again") {
                    appState.refreshCodexUpdateStatus()
                }
                .disabled(appState.isCheckingCodexUpdate || appState.isUpdatingCodex)
            }
        }
    }

    private var codexUpdateIconName: String {
        if appState.codexInstalledVersion == nil {
            return "exclamationmark.triangle.fill"
        }
        return appState.codexUpdateAvailable ? "arrow.triangle.2.circlepath.circle.fill" : "checkmark.circle.fill"
    }

    private var codexUpdateColor: Color {
        if appState.codexInstalledVersion == nil {
            return .red
        }
        return appState.codexUpdateAvailable ? .orange : .green
    }

    private var codexActivityIndicator: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !appState.isCodexWorking)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            let phase = (sin(time * (.pi * 2.0 / 1.2)) + 1.0) / 2.0
            let pulseScale = 1.0 + (0.35 * phase)

            ZStack {
                Circle()
                    .fill(codexActivityColor.opacity(appState.isCodexWorking ? 0.28 : 0.16))
                    .frame(width: 14, height: 14)
                    .scaleEffect(appState.isCodexWorking ? pulseScale : 1.0)
                Circle()
                    .fill(codexActivityColor)
                    .frame(width: 8, height: 8)
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityLabel("Codex activity")
        .accessibilityValue(appState.isCodexWorking ? "Working" : "Idle")
    }

    private var statusColor: Color {
        switch summary {
        case .error:
            return .red
        case .connecting:
            return .blue
        case .listening:
            return .red
        case .executing:
            return .orange
        case .connected:
            return .green
        case .disconnected:
            return .orange
        case .ready:
            return .secondary
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        switch summary {
        case .connecting, .executing:
            ProgressView()
                .controlSize(.small)
                .frame(width: 10, height: 10)
        default:
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
        }
    }

    private var canRevealWorkdir: Bool {
        FileManager.default.fileExists(atPath: appState.selectedWorkdir)
    }

    private var displayWorkdir: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if appState.selectedWorkdir == home {
            return "~"
        }
        if appState.selectedWorkdir.hasPrefix(home + "/") {
            let suffix = appState.selectedWorkdir.dropFirst(home.count + 1)
            return "~/" + suffix
        }
        return appState.selectedWorkdir
    }

    private func revealWorkdirInFinder() {
        let url = URL(fileURLWithPath: appState.selectedWorkdir)
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    @ViewBuilder
    private func infoRow(title: String, systemImage: String, text: String, lineLimit: Int) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label(title, systemImage: systemImage)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .lineLimit(lineLimit)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
