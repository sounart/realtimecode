import Darwin
import Foundation

/// Errors from the orchestrator IPC connection.
enum OrchestratorError: Error, LocalizedError {
    case connectionFailed(code: Int32, message: String)
    case notConnected
    case sendFailed(String)

    var errorDescription: String? {
        switch self {
        case .connectionFailed(_, let message): return "Connection failed: \(message)"
        case .notConnected: return "Not connected to orchestrator"
        case .sendFailed(let msg): return "Send failed: \(msg)"
        }
    }
}

/// Events received from the orchestrator backend.
enum OrchestratorEvent {
    case status(state: String)
    case transcript(text: String, isFinal: Bool)
    case codex(type: String, data: [String: Any])
    case error(message: String)
}

/// IPC client for the orchestrator daemon via Unix domain socket.
/// Speaks newline-delimited JSON-RPC 2.0.
final class OrchestratorClient {
    private let socketPath: String
    private var socketFd: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var readBuffer = Data()
    private var nextRequestId: Int = 1
    private let queue = DispatchQueue(label: "com.realtimecode.orchestrator-client")
    private var backendProcess: Process?
    private var launchedBackend = false
    private var reconnectTimer: DispatchSourceTimer?

    private(set) var isConnected = false

    /// Called on the main queue when an event is received.
    var onEvent: ((OrchestratorEvent) -> Void)?

    /// Called on the main queue when the connection is lost.
    var onDisconnect: (() -> Void)?

    init(socketPath: String? = nil) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.socketPath = socketPath
            ?? ProcessInfo.processInfo.environment["RTC_SOCKET_PATH"]
            ?? "\(home)/.runtime/realtimecode/orchestrator.sock"
    }

    // MARK: - Backend Spawning

    private func spawnBackend() {
        if let existing = backendProcess, existing.isRunning {
            return
        }

        let proc = Process()
        // Look for npx in common locations
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["npx", "tsx", "src/server.ts"]

        // Resolve orchestrator directory relative to the app bundle or a known location
        let orchestratorDir = ProcessInfo.processInfo.environment["RTC_ORCHESTRATOR_DIR"]
            ?? findOrchestratorDir()
        proc.currentDirectoryURL = URL(fileURLWithPath: orchestratorDir)

        // Pass through environment (especially OPENAI_API_KEY, PATH)
        var env = ProcessInfo.processInfo.environment
        env["NODE_NO_WARNINGS"] = "1"
        proc.environment = env

        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            backendProcess = proc
            launchedBackend = true
            proc.terminationHandler = { [weak self, weak proc] _ in
                DispatchQueue.main.async {
                    guard let self = self, let proc = proc else { return }
                    guard self.backendProcess === proc else { return }
                    self.backendProcess = nil
                    self.launchedBackend = false
                }
            }
        } catch {
            print("[OrchestratorClient] Failed to spawn backend: \(error)")
        }
    }

    private func terminateLaunchedBackendIfNeeded() {
        guard launchedBackend, let proc = backendProcess else { return }
        guard proc.isRunning else {
            backendProcess = nil
            launchedBackend = false
            return
        }
        proc.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self, weak proc] in
            guard let self = self, let proc = proc else { return }
            DispatchQueue.main.async {
                guard self.backendProcess === proc, self.launchedBackend, proc.isRunning else { return }
                _ = Darwin.kill(proc.processIdentifier, SIGKILL)
            }
        }
    }

    private func removeStaleSocketIfNeeded(after error: Error) {
        guard FileManager.default.fileExists(atPath: socketPath) else { return }
        guard case .connectionFailed(code: let code, message: _) = (error as? OrchestratorError) else { return }
        guard code == ECONNREFUSED else { return }
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    private func shouldRespawnBackend(spawnedOnce: Bool) -> Bool {
        if !spawnedOnce { return true }
        guard let proc = backendProcess else { return true }
        return !proc.isRunning
    }

    private func findOrchestratorDir() -> String {
        // Try common locations relative to the user's home
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/Code/realtimecode/services/orchestrator",
            "\(home)/code/realtimecode/services/orchestrator",
            "\(home)/Developer/realtimecode/services/orchestrator",
        ]
        for candidate in candidates {
            if FileManager.default.fileExists(atPath: "\(candidate)/src/server.ts") {
                return candidate
            }
        }
        return candidates[0]
    }

    // MARK: - Connection

    func connect() throws {
        guard !isConnected else { return }

        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            throw OrchestratorError.connectionFailed(
                code: errno,
                message: "socket() failed: \(String(cString: strerror(errno)))"
            )
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            close(socketFd)
            socketFd = -1
            throw OrchestratorError.connectionFailed(code: ENAMETOOLONG, message: "Socket path too long")
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { dest in
                for (i, byte) in pathBytes.enumerated() {
                    dest[i] = byte
                }
            }
        }

        let connectResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Foundation.connect(socketFd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard connectResult == 0 else {
            let errCode = errno
            let errMsg = String(cString: strerror(errCode))
            close(socketFd)
            socketFd = -1
            throw OrchestratorError.connectionFailed(code: errCode, message: errMsg)
        }

        // Set non-blocking
        let flags = fcntl(socketFd, F_GETFL)
        _ = fcntl(socketFd, F_SETFL, flags | O_NONBLOCK)

        isConnected = true
        startReading()
    }

    /// Spawn backend if needed, then connect with retries.
    func connectWithSpawn(
        retries: Int = 10,
        delay: TimeInterval = 0.5,
        onConnected: (() -> Void)? = nil,
        onFailure: ((String) -> Void)? = nil
    ) {
        reconnectTimer?.cancel()
        reconnectTimer = nil

        var attempts = 0
        var spawned = false
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: delay)
        timer.setEventHandler { [weak self] in
            guard let self = self else { timer.cancel(); return }
            attempts += 1

            do {
                try self.connect()
                timer.cancel()
                self.reconnectTimer = nil
                onConnected?()
            } catch {
                if self.shouldRespawnBackend(spawnedOnce: spawned) {
                    self.removeStaleSocketIfNeeded(after: error)
                    self.spawnBackend()
                    spawned = true
                }
                if attempts >= retries {
                    timer.cancel()
                    self.reconnectTimer = nil
                    let message = "Failed to connect to backend after \(retries) attempts"
                    self.onEvent?(.error(message: message))
                    onFailure?(message)
                }
            }
        }
        timer.resume()
        reconnectTimer = timer
    }

    func disconnect() {
        reconnectTimer?.cancel()
        reconnectTimer = nil

        if readSource != nil {
            readSource?.cancel()
            readSource = nil
        }
        if socketFd >= 0 {
            close(socketFd)
            socketFd = -1
        }

        isConnected = false
        readBuffer = Data()
        terminateLaunchedBackendIfNeeded()
    }

    // MARK: - JSON-RPC Methods

    /// Start listening in the given working directory.
    func start(workdir: String) {
        let id = nextId()
        sendRequest(id: id, method: "start", params: ["workdir": workdir])
    }

    /// Stop everything.
    func stop() {
        let id = nextId()
        sendRequest(id: id, method: "stop", params: [:])
    }

    /// Stream an audio chunk (base64-encoded PCM16 24kHz mono).
    func streamAudio(base64Chunk: String) {
        let notification: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "audio",
            "params": ["chunk": base64Chunk]
        ]
        sendJSON(notification)
    }

    // MARK: - Internal

    private func nextId() -> Int {
        let id = nextRequestId
        nextRequestId += 1
        return id
    }

    private func sendRequest(id: Int, method: String, params: [String: Any]) {
        let request: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        ]
        sendJSON(request)
    }

    private func sendJSON(_ object: [String: Any]) {
        guard isConnected else { return }

        queue.async { [weak self] in
            guard let self = self, self.isConnected else { return }

            guard let jsonData = try? JSONSerialization.data(withJSONObject: object),
                  var line = String(data: jsonData, encoding: .utf8) else { return }

            line.append("\n")
            guard let lineData = line.data(using: .utf8) else { return }
            self.writeLineData(lineData)
        }
    }

    private func writeLineData(_ lineData: Data, from initialOffset: Int = 0) {
        guard isConnected else { return }

        lineData.withUnsafeBytes { ptr in
            guard let baseAddress = ptr.baseAddress else { return }
            var sent = initialOffset

            while sent < lineData.count {
                let result = write(self.socketFd, baseAddress + sent, lineData.count - sent)
                if result > 0 {
                    sent += result
                    continue
                }
                let err = errno
                if err == EINTR { continue }
                if err == EAGAIN || err == EWOULDBLOCK {
                    let nextOffset = sent
                    queue.asyncAfter(deadline: .now() + .milliseconds(5)) { [weak self] in
                        guard let self = self else { return }
                        self.writeLineData(lineData, from: nextOffset)
                    }
                    return
                }

                DispatchQueue.main.async { [weak self] in
                    self?.handleDisconnect()
                }
                return
            }
        }
    }

    private func startReading() {
        let source = DispatchSource.makeReadSource(fileDescriptor: socketFd, queue: queue)

        source.setEventHandler { [weak self] in
            guard let self = self else { return }

            var buf = [UInt8](repeating: 0, count: 8192)
            let bytesRead = read(self.socketFd, &buf, buf.count)

            if bytesRead == 0 {
                DispatchQueue.main.async { self.handleDisconnect() }
                return
            }
            if bytesRead < 0 {
                let err = errno
                if err == EINTR || err == EAGAIN || err == EWOULDBLOCK { return }
                DispatchQueue.main.async { self.handleDisconnect() }
                return
            }

            self.readBuffer.append(contentsOf: buf[0..<bytesRead])
            self.processReadBuffer()
        }

        source.setCancelHandler { [weak self] in
            guard let self = self else { return }
            if self.socketFd >= 0 {
                close(self.socketFd)
                self.socketFd = -1
            }
        }

        source.resume()
        readSource = source
    }

    private func processReadBuffer() {
        while let newlineIndex = readBuffer.firstIndex(of: UInt8(ascii: "\n")) {
            let lineData = readBuffer[readBuffer.startIndex..<newlineIndex]
            readBuffer = Data(readBuffer[(newlineIndex + 1)...])

            guard !lineData.isEmpty,
                  let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                continue
            }

            DispatchQueue.main.async { [weak self] in
                self?.handleMessage(json)
            }
        }
    }

    private func handleMessage(_ json: [String: Any]) {
        // JSON-RPC response (has id) — check for errors
        if json["id"] != nil {
            if let error = json["error"] as? [String: Any],
               let message = error["message"] as? String {
                onEvent?(.error(message: message))
            }
            return
        }

        // JSON-RPC notification
        guard let method = json["method"] as? String,
              let params = json["params"] as? [String: Any] else { return }

        switch method {
        case "status":
            let state = params["state"] as? String ?? "unknown"
            onEvent?(.status(state: state))

        case "transcript":
            let text = params["text"] as? String ?? ""
            let isFinal = params["final"] as? Bool ?? false
            onEvent?(.transcript(text: text, isFinal: isFinal))

        case "codex":
            let type = params["type"] as? String ?? ""
            let data = params["data"] as? [String: Any] ?? [:]
            onEvent?(.codex(type: type, data: data))

        case "error":
            let message = params["message"] as? String ?? "Unknown error"
            onEvent?(.error(message: message))

        default:
            break
        }
    }

    private func handleDisconnect() {
        isConnected = false
        readSource?.cancel()
        readSource = nil
        if socketFd >= 0 {
            close(socketFd)
            socketFd = -1
        }
        onDisconnect?()
    }
}
