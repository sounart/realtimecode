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
    @Published var selectedWorkdir: String
    @Published var hotkeyPreset: HotkeyPreset
    @Published var hotkeyEnabled = true

    let micService = MicCaptureService()
    let hotkeyManager = HotkeyManager()
    let orchestratorClient = OrchestratorClient()

    private let defaultWorkdir = ProcessInfo.processInfo.environment["RTC_WORKDIR"]
        ?? FileManager.default.homeDirectoryForCurrentUser.path

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.workdirKey),
           FileManager.default.fileExists(atPath: saved) {
            self.selectedWorkdir = saved
        } else {
            self.selectedWorkdir = defaultWorkdir
        }
        self.hotkeyPreset = hotkeyManager.preset
        setupMicService()
        setupHotkeyManager()
        setupOrchestratorClient()
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
        hotkeyPreset = preset
    }

    func toggleHotkeyListening() {
        if hotkeyEnabled {
            hotkeyManager.stopListening()
        } else {
            hotkeyManager.startListening()
        }
        hotkeyEnabled = hotkeyManager.isListening
    }

    func quit() {
        if isRecording { stopRecording() }
        orchestratorClient.disconnect()
        hotkeyManager.stopListening()
        NSApplication.shared.terminate(nil)
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

        Menu {
            ForEach(HotkeyPreset.allCases) { preset in
                Button {
                    appState.setHotkeyPreset(preset)
                } label: {
                    if preset == appState.hotkeyPreset {
                        Label(preset.displayName, systemImage: "checkmark")
                    } else {
                        Text(preset.displayName)
                    }
                }
            }
        } label: {
            Label("Hotkey: \(appState.hotkeyPreset.displayName)", systemImage: "keyboard")
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
