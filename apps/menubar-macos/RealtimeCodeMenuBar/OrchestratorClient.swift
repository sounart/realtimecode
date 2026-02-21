import Darwin
import Foundation

/// Errors from the orchestrator IPC connection.
enum OrchestratorError: Error, LocalizedError {
    case connectionFailed(String)
    case notConnected
    case sendFailed(String)
    case invalidResponse(String)
    case requestTimeout(String)

    var errorDescription: String? {
        switch self {
        case .connectionFailed(let msg): return "Connection failed: \(msg)"
        case .notConnected: return "Not connected to orchestrator"
        case .sendFailed(let msg): return "Send failed: \(msg)"
        case .invalidResponse(let msg): return "Invalid response: \(msg)"
        case .requestTimeout(let msg): return "Request timeout: \(msg)"
        }
    }
}

/// Events received from the orchestrator.
enum OrchestratorEvent {
    case status(state: String, sessionId: String)
    case transcript(text: String, isFinal: Bool)
    case error(message: String, recoverable: Bool)
    case stdout(instructionId: String, chunk: String)
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

    /// Pending request callbacks keyed by request id, with their timeout timers.
    private var pendingRequests: [Int: (callback: ([String: Any]?) -> Void, timer: DispatchSourceTimer)] = [:]

    /// Default timeout for JSON-RPC requests (seconds).
    var requestTimeout: TimeInterval = 10.0

    private(set) var isConnected = false

    /// Whether the client should automatically retry connection on failure/disconnect.
    private var autoReconnect = false
    private var reconnectTimer: DispatchSourceTimer?
    private var reconnectAttempt = 0
    private static let maxReconnectDelay: TimeInterval = 30.0
    private static let initialReconnectDelay: TimeInterval = 1.0

    /// Called on the main queue when an event is received from the orchestrator.
    var onEvent: ((OrchestratorEvent) -> Void)?

    /// Called on the main queue when the connection is lost.
    var onDisconnect: (() -> Void)?

    /// Called on the main queue when the connection is established.
    var onConnect: (() -> Void)?

    init(socketPath: String? = nil) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        self.socketPath = socketPath
            ?? ProcessInfo.processInfo.environment["RTC_SOCKET_PATH"]
            ?? "\(home)/.runtime/realtimecode/orchestrator.sock"
    }

    // MARK: - Connection

    func connect() throws {
        guard !isConnected else { return }

        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            throw OrchestratorError.connectionFailed("socket() failed: \(String(cString: strerror(errno)))")
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            Darwin.close(socketFd)
            socketFd = -1
            throw OrchestratorError.connectionFailed("Socket path too long")
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
            let errMsg = String(cString: strerror(errno))
            Darwin.close(socketFd)
            socketFd = -1
            throw OrchestratorError.connectionFailed(errMsg)
        }

        // Set non-blocking
        let flags = fcntl(socketFd, F_GETFL)
        _ = fcntl(socketFd, F_SETFL, flags | O_NONBLOCK)

        isConnected = true
        reconnectAttempt = 0
        startReading()

        DispatchQueue.main.async { [weak self] in
            self?.onConnect?()
        }
    }

    func disconnect() {
        autoReconnect = false
        cancelReconnectTimer()
        performDisconnect()
    }

    /// Connect with automatic retry using exponential backoff.
    /// Retries at 1s, 2s, 4s, 8s, 16s, 30s intervals until connected.
    func connectWithRetry() {
        autoReconnect = true
        attemptConnection()
    }

    // MARK: - JSON-RPC Methods

    /// Start an orchestrator session for the given working directory.
    func sessionStart(workdir: String, profile: String = "default", completion: (([String: Any]?) -> Void)? = nil) {
        let id = nextId()
        let params: [String: Any] = ["workdir": workdir, "profile": profile]
        sendRequest(id: id, method: "session.start", params: params, completion: completion)
    }

    /// Stop the current orchestrator session.
    func sessionStop(sessionId: String, completion: (([String: Any]?) -> Void)? = nil) {
        let id = nextId()
        let params: [String: Any] = ["sessionId": sessionId]
        sendRequest(id: id, method: "session.stop", params: params, completion: completion)
    }

    /// Stream an audio chunk (base64-encoded PCM16 24kHz mono).
    /// Sent as a JSON-RPC notification (no response expected).
    func streamAudio(base64Chunk: String) {
        let notification: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "audio.stream",
            "params": ["audio": base64Chunk]
        ]
        sendJSON(notification)
    }

    /// Commit the current audio buffer (for push-to-talk release).
    func commitAudioBuffer() {
        let notification: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "audio.commit",
            "params": [String: Any]()
        ]
        sendJSON(notification)
    }

    // MARK: - Internal

    private func nextId() -> Int {
        let id = nextRequestId
        nextRequestId += 1
        return id
    }

    private func sendRequest(id: Int, method: String, params: [String: Any], completion: (([String: Any]?) -> Void)? = nil) {
        let request: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        ]

        if let completion = completion {
            // Set up timeout timer
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + requestTimeout)
            timer.setEventHandler { [weak self] in
                guard let self = self else { return }
                if let pending = self.pendingRequests.removeValue(forKey: id) {
                    pending.timer.cancel()
                    DispatchQueue.main.async {
                        self.onEvent?(.error(
                            message: "Request '\(method)' timed out after \(Int(self.requestTimeout))s",
                            recoverable: true
                        ))
                        completion(nil)
                    }
                }
            }
            timer.resume()

            pendingRequests[id] = (callback: completion, timer: timer)
        }

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

            lineData.withUnsafeBytes { ptr in
                guard let baseAddress = ptr.baseAddress else { return }
                var sent = 0
                while sent < lineData.count {
                    let result = Darwin.write(self.socketFd, baseAddress + sent, lineData.count - sent)
                    if result <= 0 {
                        DispatchQueue.main.async {
                            self.handleDisconnect()
                        }
                        return
                    }
                    sent += result
                }
            }
        }
    }

    private func startReading() {
        let source = DispatchSource.makeReadSource(fileDescriptor: socketFd, queue: queue)

        source.setEventHandler { [weak self] in
            guard let self = self else { return }

            var buf = [UInt8](repeating: 0, count: 8192)
            let bytesRead = Darwin.read(self.socketFd, &buf, buf.count)

            if bytesRead <= 0 {
                DispatchQueue.main.async { self.handleDisconnect() }
                return
            }

            self.readBuffer.append(contentsOf: buf[0..<bytesRead])
            self.processReadBuffer()
        }

        source.setCancelHandler { [weak self] in
            guard let self = self else { return }
            if self.socketFd >= 0 {
                Darwin.close(self.socketFd)
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
        // JSON-RPC response (has id)
        if let id = json["id"] as? Int {
            if let pending = pendingRequests.removeValue(forKey: id) {
                pending.timer.cancel()
                if let error = json["error"] as? [String: Any],
                   let message = error["message"] as? String {
                    onEvent?(.error(message: message, recoverable: true))
                    pending.callback(nil)
                } else {
                    pending.callback(json["result"] as? [String: Any])
                }
            } else if let error = json["error"] as? [String: Any],
                      let message = error["message"] as? String {
                onEvent?(.error(message: message, recoverable: true))
            }
            return
        }

        // JSON-RPC notification (event from orchestrator)
        guard let method = json["method"] as? String,
              let params = json["params"] as? [String: Any] else { return }

        switch method {
        case "event.status":
            let state = params["state"] as? String ?? "unknown"
            let sessionId = params["sessionId"] as? String ?? ""
            onEvent?(.status(state: state, sessionId: sessionId))

        case "event.transcript":
            let text = params["text"] as? String ?? ""
            let isFinal = params["isFinal"] as? Bool ?? false
            onEvent?(.transcript(text: text, isFinal: isFinal))

        case "event.error":
            let message = params["message"] as? String ?? "Unknown error"
            let recoverable = params["recoverable"] as? Bool ?? true
            onEvent?(.error(message: message, recoverable: recoverable))

        case "event.stdout":
            let instructionId = params["instructionId"] as? String ?? ""
            let chunk = params["chunk"] as? String ?? ""
            onEvent?(.stdout(instructionId: instructionId, chunk: chunk))

        default:
            break
        }
    }

    // MARK: - Connection Management

    private func performDisconnect() {
        guard isConnected else { return }
        // Cancel all pending requests
        for (_, pending) in pendingRequests {
            pending.timer.cancel()
        }
        pendingRequests.removeAll()

        readSource?.cancel()
        readSource = nil
        if socketFd >= 0 {
            Darwin.close(socketFd)
            socketFd = -1
        }
        isConnected = false
        readBuffer = Data()
    }

    private func handleDisconnect() {
        performDisconnect()
        onDisconnect?()

        if autoReconnect {
            scheduleReconnect()
        }
    }

    private func attemptConnection() {
        do {
            try connect()
        } catch {
            if autoReconnect {
                scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        cancelReconnectTimer()

        let delay = min(
            Self.initialReconnectDelay * pow(2.0, Double(reconnectAttempt)),
            Self.maxReconnectDelay
        )
        reconnectAttempt += 1

        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + delay)
        timer.setEventHandler { [weak self] in
            self?.attemptConnection()
        }
        timer.resume()
        reconnectTimer = timer
    }

    private func cancelReconnectTimer() {
        reconnectTimer?.cancel()
        reconnectTimer = nil
    }
}
