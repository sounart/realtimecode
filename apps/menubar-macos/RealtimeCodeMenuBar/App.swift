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
    @Published var lastAction = ""
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
                case "executing":
                    self.statusText = "Executing..."
                case "idle":
                    self.statusText = "Ready"
                default:
                    self.statusText = state.capitalized
                }

            case .transcript(let text, let isFinal):
                if isFinal {
                    self.currentTranscript = ""
                    self.lastAction = text
                } else {
                    self.currentTranscript = text
                }

            case .codex(let type, let data):
                switch type {
                case "tool_call":
                    let tool = data["tool"] as? String ?? ""
                    self.lastAction = "Running \(tool)..."
                case "file_change":
                    let path = data["path"] as? String ?? ""
                    let changeType = data["changeType"] as? String ?? "update"
                    self.lastAction = "\(changeType.capitalized) \(path)"
                case "done":
                    if self.statusText == "Executing..." {
                        self.statusText = "Listening..."
                    }
                default:
                    break
                }

            case .error(let message):
                self.statusText = "Error: \(message)"
                print("[RealtimeCode] Error: \(message)")
            }
        }

        orchestratorClient.onDisconnect = { [weak self] in
            guard let self = self else { return }
            self.isConnected = false
            self.statusText = "Disconnected"
            // Auto-reconnect if we were recording
            if self.isRecording {
                self.isRecording = false
                self.micService.stopCapture()
                self.reconnect()
            }
        }
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
        orchestratorClient.stop()
        statusText = "Ready"
        currentTranscript = ""
    }

    private func connectAndStart() {
        statusText = "Connecting..."
        orchestratorClient.connectWithSpawn { [weak self] in
            // This is called if spawn+connect fails (via onEvent .error)
        }

        // Poll for connection, then start
        var attempts = 0
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            attempts += 1
            if self.orchestratorClient.isConnected {
                timer.invalidate()
                self.isConnected = true
                self.orchestratorClient.start(workdir: self.selectedWorkdir)
                self.beginMicCapture()
            } else if attempts >= 10 {
                timer.invalidate()
                self.statusText = "Connection failed"
            }
        }
    }

    private func reconnect() {
        statusText = "Reconnecting..."
        orchestratorClient.connectWithSpawn()
        var attempts = 0
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            attempts += 1
            if self.orchestratorClient.isConnected {
                timer.invalidate()
                self.isConnected = true
                self.statusText = "Ready"
            } else if attempts >= 10 {
                timer.invalidate()
                self.statusText = "Reconnect failed"
            }
        }
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
        if appState.isRecording {
            return "mic.circle.fill"
        } else if appState.isConnected {
            return "mic"
        } else {
            return "mic.slash"
        }
    }
}

// MARK: - Menu Content

struct MenuContent: View {
    @ObservedObject var appState: AppState

    var body: some View {
        Text(appState.statusText)
            .font(.headline)

        if !appState.currentTranscript.isEmpty {
            Text(appState.currentTranscript)
                .font(.caption)
                .lineLimit(3)
        }

        if !appState.lastAction.isEmpty {
            Text(appState.lastAction)
                .font(.caption2)
                .lineLimit(2)
        }

        Divider()

        Button(appState.isRecording ? "Stop Recording" : "Start Recording") {
            if appState.isRecording {
                appState.stopRecording()
            } else {
                appState.startRecording()
            }
        }

        Divider()

        Text(appState.selectedWorkdir)
            .font(.caption2)
            .lineLimit(1)
            .truncationMode(.middle)

        Button("Choose Directory...") {
            appState.chooseWorkdir()
        }

        Divider()

        Menu("Hotkey: \(appState.hotkeyPreset.displayName)") {
            ForEach(HotkeyPreset.allCases) { preset in
                Button(preset.displayName) {
                    appState.setHotkeyPreset(preset)
                }
            }
        }

        Button(appState.hotkeyEnabled ? "Disable Hotkey" : "Enable Hotkey") {
            appState.toggleHotkeyListening()
        }

        Divider()

        Button("Quit") {
            appState.quit()
        }
        .keyboardShortcut("q")
    }
}
