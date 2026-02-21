import SwiftUI

/// Observable app state shared across the menu bar UI.
@MainActor
final class AppState: ObservableObject {
    @Published var isRecording = false
    @Published var isConnected = false
    @Published var statusText = "Idle"
    @Published var lastTranscript = ""

    let micService = MicCaptureService()
    let hotkeyManager = HotkeyManager()
    let orchestratorClient = OrchestratorClient()

    private var sessionId: String?

    init() {
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
        hotkeyManager.mode = .toggle

        hotkeyManager.onRecordingStart = { [weak self] in
            guard let self = self else { return }
            if self.hotkeyManager.mode == .toggle {
                if self.isRecording {
                    self.stopRecording(commit: true)
                } else {
                    self.startRecording()
                }
            } else {
                // Push-to-talk: key down starts recording
                self.startRecording()
            }
        }

        hotkeyManager.onRecordingStop = { [weak self] in
            // Push-to-talk: key release stops and commits
            self?.stopRecording(commit: true)
        }
    }

    private func setupOrchestratorClient() {
        orchestratorClient.onEvent = { [weak self] event in
            guard let self = self else { return }
            switch event {
            case .status(let state, let sid):
                self.sessionId = sid
                self.statusText = state.capitalized
            case .transcript(let text, let isFinal):
                if isFinal {
                    self.lastTranscript = text
                    self.statusText = "Transcribed"
                } else {
                    self.statusText = "Transcribing..."
                }
            case .error(let message, _):
                self.statusText = "Error: \(message)"
            }
        }

        orchestratorClient.onDisconnect = { [weak self] in
            self?.isConnected = false
            self?.statusText = "Disconnected"
        }
    }

    // MARK: - Actions

    func connectToOrchestrator() {
        do {
            try orchestratorClient.connect()
            isConnected = true
            statusText = "Connected"
        } catch {
            statusText = "Connection failed"
            isConnected = false
        }
    }

    func startRecording() {
        micService.requestPermission { [weak self] granted in
            guard let self = self, granted else {
                self?.statusText = "Mic permission denied"
                return
            }
            do {
                try self.micService.startCapture()
                self.isRecording = true
                self.statusText = "Recording"
            } catch {
                self.statusText = "Mic error: \(error.localizedDescription)"
            }
        }
    }

    func stopRecording(commit: Bool) {
        micService.stopCapture()
        isRecording = false
        if commit {
            orchestratorClient.commitAudioBuffer()
            statusText = "Committed"
        } else {
            statusText = "Stopped"
        }
    }

    func toggleRecordingMode() {
        hotkeyManager.mode = hotkeyManager.mode == .toggle ? .pushToTalk : .toggle
    }

    func quit() {
        stopRecording(commit: false)
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
        // Hide from Dock — menu bar only
        NSApp.setActivationPolicy(.accessory)
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
        // Status
        Text(appState.statusText)
            .font(.headline)

        if !appState.lastTranscript.isEmpty {
            Text(appState.lastTranscript)
                .font(.caption)
                .lineLimit(3)
        }

        Divider()

        // Toggle Recording
        Button(appState.isRecording ? "Stop Recording" : "Start Recording") {
            if appState.isRecording {
                appState.stopRecording(commit: true)
            } else {
                appState.startRecording()
            }
        }
        .keyboardShortcut("r", modifiers: [.command, .shift])

        // Recording Mode
        Button("Mode: \(appState.hotkeyManager.mode == .toggle ? "Toggle" : "Push-to-Talk")") {
            appState.toggleRecordingMode()
        }

        Divider()

        // Connection
        if appState.isConnected {
            Text("Connected to orchestrator")
                .font(.caption)
        } else {
            Button("Connect to Orchestrator") {
                appState.connectToOrchestrator()
            }
        }

        // Hotkey
        if appState.hotkeyManager.isListening {
            Text("Hotkey: Cmd+Shift+R")
                .font(.caption)
        } else {
            Button("Enable Hotkey") {
                appState.hotkeyManager.startListening()
            }
        }

        Divider()

        Button("Quit") {
            appState.quit()
        }
        .keyboardShortcut("q")
    }
}
