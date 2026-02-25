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
    private static let audioNotificationPrefix = Data("{\"jsonrpc\":\"2.0\",\"method\":\"audio\",\"params\":{\"chunk\":\"".utf8)
    private static let audioNotificationSuffix = Data("\"}}\n".utf8)
    private static let maxIncomingBufferBytes = 1_048_576
    private static let maxAudioChunkBase64Chars = 256_000

    private let socketPath: String
    private let authTokenPath: String
    private var authToken: String
    private var socketFd: Int32 = -1
    private var readSource: DispatchSourceRead?
    private var readBuffer = Data()
    private var nextRequestId: Int = 1
    private let queue = DispatchQueue(label: "com.realtimecode.orchestrator-client")
    private var backendProcess: Process?
    private var launchedBackend = false
    private var reconnectTimer: DispatchSourceTimer?

    private(set) var isConnected = false
    private var isAuthenticated = false
    private var authRequestId: Int?
    private var authRetryAttempted = false
    private var pendingOutboundMessages: [[String: Any]] = []

    /// Called on the main queue when an event is received.
    var onEvent: ((OrchestratorEvent) -> Void)?

    /// Called on the main queue when the connection is lost.
    var onDisconnect: (() -> Void)?

    init(socketPath: String? = nil) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let runtimeDir = "\(home)/.runtime/realtimecode"
        self.socketPath = socketPath
            ?? ProcessInfo.processInfo.environment["RTC_SOCKET_PATH"]
            ?? "\(runtimeDir)/orchestrator.sock"
        let socketDir = URL(fileURLWithPath: self.socketPath)
            .deletingLastPathComponent()
            .path
        self.authTokenPath = ProcessInfo.processInfo.environment["RTC_AUTH_TOKEN_PATH"]
            ?? "\(socketDir)/orchestrator.token"
        self.authToken = Self.resolveAuthToken(
            explicitToken: ProcessInfo.processInfo.environment["RTC_AUTH_TOKEN"],
            tokenPath: self.authTokenPath
        )
    }

    // MARK: - Backend Spawning

    private func spawnBackend() {
        if let existing = backendProcess, existing.isRunning {
            return
        }

        // Resolve orchestrator directory relative to the app bundle or a known location
        let orchestratorDir = ProcessInfo.processInfo.environment["RTC_ORCHESTRATOR_DIR"]
            ?? findOrchestratorDir()

        guard let nodePath = resolveNodeExecutable() else {
            print("[OrchestratorClient] Failed to spawn backend: could not find a Node executable")
            return
        }
        guard let tsxCliPath = resolveTsxCliPath(orchestratorDir: orchestratorDir) else {
            print("[OrchestratorClient] Failed to spawn backend: could not find tsx CLI in node_modules")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [tsxCliPath, "src/server.ts"]
        proc.currentDirectoryURL = URL(fileURLWithPath: orchestratorDir)
        proc.environment = buildBackendEnvironment()
        if ProcessInfo.processInfo.environment["RTC_BACKEND_STDIO"]?.lowercased() == "null" {
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
        }

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
        guard isSocketFile(atPath: socketPath) else { return }
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

    private func resolveNodeExecutable() -> String? {
        let env = ProcessInfo.processInfo.environment
        let candidates = [
            env["RTC_NODE_PATH"],
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ].compactMap { $0 }

        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }

    private func resolveTsxCliPath(orchestratorDir: String) -> String? {
        let rootTsx = URL(fileURLWithPath: orchestratorDir)
            .appendingPathComponent("../../node_modules/tsx/dist/cli.mjs")
            .standardizedFileURL.path
        let localTsx = URL(fileURLWithPath: orchestratorDir)
            .appendingPathComponent("node_modules/tsx/dist/cli.mjs")
            .standardizedFileURL.path

        for path in [rootTsx, localTsx] where FileManager.default.fileExists(atPath: path) {
            return path
        }
        return nil
    }

    private func buildBackendEnvironment() -> [String: String] {
        let inherited = ProcessInfo.processInfo.environment
        var env: [String: String] = [:]

        for key in ["HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "SHELL", "USER", "LOGNAME"] {
            if let value = inherited[key], !value.isEmpty {
                env[key] = value
            }
        }
        env["PATH"] = sanitizePath(inherited["PATH"])

        let allowlist = [
            "OPENAI_API_KEY",
            "CODEX_COMMAND",
            "HTTPS_PROXY",
            "HTTP_PROXY",
            "NO_PROXY",
            "RTC_SOCKET_PATH",
            "RTC_LOG_PATH",
            "RTC_LOG_STDOUT",
            "RTC_LOG_FILE",
            "RTC_CODEX_TIMEOUT_MS",
            "RTC_CODEX_KILL_GRACE_MS",
            "RTC_CODEX_EPHEMERAL",
            "RTC_CODEX_SKIP_GIT_REPO_CHECK",
            "RTC_CODEX_MODEL",
            "RTC_CODEX_FULL_AUTO",
            "RTC_CODEX_SANDBOX_MODE",
            "RTC_REALTIME_URL",
            "RTC_ALLOW_CUSTOM_REALTIME_URL",
            "RTC_REALTIME_SESSION_MODEL",
            "RTC_REALTIME_MODEL",
            "RTC_TRANSCRIBE_MODEL",
            "RTC_TRANSCRIBE_LANGUAGE",
            "RTC_MAX_RPC_LINE_BYTES",
            "RTC_MAX_AUDIO_CHUNK_BASE64_CHARS",
            "RTC_LOG_INSTRUCTION_PREVIEW",
            "RTC_TRANSCRIPT_COMMIT_DELAY_MS",
            "RTC_MIN_EXECUTABLE_TRANSCRIPT_CHARS",
            "RTC_MIN_EXECUTABLE_TRANSCRIPT_WORDS",
            "RTC_MAX_PENDING_INSTRUCTIONS",
            "RTC_TRANSCRIPT_DEDUPE_WINDOW_MS",
        ]
        for key in allowlist {
            if let value = inherited[key], !value.isEmpty {
                env[key] = value
            }
        }

        env["RTC_AUTH_REQUIRED"] = inherited["RTC_AUTH_REQUIRED"] ?? "1"
        env["RTC_AUTH_TOKEN_PATH"] = authTokenPath
        env["RTC_AUTH_TOKEN"] = authToken
        env["NODE_NO_WARNINGS"] = "1"
        return env
    }

    private func sanitizePath(_ rawPath: String?) -> String {
        let fallback = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"]
        let sourceParts = (rawPath ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        var result: [String] = []

        for part in sourceParts {
            guard part.hasPrefix("/") else { continue }
            if seen.insert(part).inserted {
                result.append(part)
            }
        }
        for part in fallback where seen.insert(part).inserted {
            result.append(part)
        }
        return result.joined(separator: ":")
    }

    private func isSocketFile(atPath path: String) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let fileType = attrs[.type] as? FileAttributeType else {
            return false
        }
        return fileType == .typeSocket
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
        isAuthenticated = false
        authRequestId = nil
        authRetryAttempted = false
        pendingOutboundMessages.removeAll(keepingCapacity: false)
        startReading()
        authenticate()
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
        isAuthenticated = false
        authRequestId = nil
        authRetryAttempted = false
        pendingOutboundMessages.removeAll(keepingCapacity: false)
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
        guard base64Chunk.utf8.count <= Self.maxAudioChunkBase64Chars else {
            onEvent?(.error(message: "Audio chunk too large; dropped"))
            return
        }
        guard isConnected, isAuthenticated else { return }
        queue.async { [weak self] in
            guard let self = self, self.isConnected, self.isAuthenticated else { return }
            self.sendAudioNotification(base64Chunk)
        }
    }

    // MARK: - Internal

    private func authenticate() {
        let id = nextId()
        authRequestId = id
        sendRequest(id: id, method: "auth", params: ["token": authToken])
    }

    private static func readAuthTokenFromDisk(tokenPath: String) -> String? {
        guard let fileToken = try? String(contentsOfFile: tokenPath, encoding: .utf8) else {
            return nil
        }
        let trimmed = fileToken.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count >= 16 ? trimmed : nil
    }

    private static func resolveAuthToken(explicitToken: String?, tokenPath: String) -> String {
        if let explicitToken {
            let trimmed = explicitToken.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.count >= 16 {
                return trimmed
            }
        }

        if let diskToken = readAuthTokenFromDisk(tokenPath: tokenPath) {
            return diskToken
        }

        return UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    private func refreshAuthTokenFromDisk() -> Bool {
        guard let diskToken = Self.readAuthTokenFromDisk(tokenPath: authTokenPath) else {
            return false
        }
        authToken = diskToken
        return true
    }

    private func flushPendingOutboundMessages() {
        guard isConnected, isAuthenticated, !pendingOutboundMessages.isEmpty else { return }
        let queued = pendingOutboundMessages
        pendingOutboundMessages.removeAll(keepingCapacity: false)
        for message in queued {
            sendJSON(message)
        }
    }

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
        let method = object["method"] as? String
        if !isAuthenticated && method != "auth" {
            pendingOutboundMessages.append(object)
            return
        }

        queue.async { [weak self] in
            guard let self = self, self.isConnected else { return }

            guard let jsonData = try? JSONSerialization.data(withJSONObject: object),
                  var line = String(data: jsonData, encoding: .utf8) else { return }

            line.append("\n")
            guard let lineData = line.data(using: .utf8) else { return }
            self.writeLineData(lineData)
        }
    }

    private func sendAudioNotification(_ base64Chunk: String) {
        // Base64 only contains JSON-safe characters, so this avoids per-chunk JSONSerialization overhead.
        var lineData = Data(
            capacity: Self.audioNotificationPrefix.count
                + base64Chunk.utf8.count
                + Self.audioNotificationSuffix.count
        )
        lineData.append(Self.audioNotificationPrefix)
        lineData.append(contentsOf: base64Chunk.utf8)
        lineData.append(Self.audioNotificationSuffix)
        writeLineData(lineData)
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
            if self.readBuffer.count > Self.maxIncomingBufferBytes {
                self.readBuffer.removeAll(keepingCapacity: false)
                DispatchQueue.main.async {
                    self.onEvent?(.error(message: "Backend message exceeded size limit"))
                    self.handleDisconnect()
                }
                return
            }
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
        let responseId: Int? = {
            if let intId = json["id"] as? Int { return intId }
            if let numId = json["id"] as? NSNumber { return numId.intValue }
            return nil
        }()

        if let responseId {
            let errorMessage = (json["error"] as? [String: Any])?["message"] as? String

            if responseId == authRequestId {
                if let message = errorMessage {
                    isAuthenticated = false
                    authRequestId = nil

                    if message == "Unauthorized: invalid token" && !authRetryAttempted && refreshAuthTokenFromDisk() {
                        authRetryAttempted = true
                        authenticate()
                        return
                    }

                    pendingOutboundMessages.removeAll(keepingCapacity: false)
                    onEvent?(.error(message: message))
                    return
                }

                isAuthenticated = true
                authRequestId = nil
                authRetryAttempted = false
                flushPendingOutboundMessages()
                return
            }

            if let message = errorMessage {
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
        isAuthenticated = false
        authRequestId = nil
        authRetryAttempted = false
        pendingOutboundMessages.removeAll(keepingCapacity: false)
        readSource?.cancel()
        readSource = nil
        if socketFd >= 0 {
            close(socketFd)
            socketFd = -1
        }
        onDisconnect?()
    }
}
