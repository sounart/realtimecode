import Foundation
import Darwin

enum CodexUpdateAvailability {
    case upToDate
    case updateAvailable
    case latestUnknown
    case notInstalled
}

struct CodexUpdateStatus {
    let installedVersion: String?
    let latestVersion: String?
    let availability: CodexUpdateAvailability
    let message: String?
}

struct CodexUpdateOperationResult {
    let success: Bool
    let message: String
}

private struct CommandResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
    let timedOut: Bool

    var combinedOutput: String {
        [stdout, stderr]
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum CodexUpdateService {
    private static let codexPackageName = "@openai/codex"

    static func checkStatus() -> CodexUpdateStatus {
        let codexCommand = (ProcessInfo.processInfo.environment["CODEX_COMMAND"] ?? "codex")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let installedResult = runCommand(
            executable: "/usr/bin/env",
            arguments: [codexCommand.isEmpty ? "codex" : codexCommand, "--version"],
            timeout: 8
        )

        guard installedResult.exitCode == 0,
              let installedVersion = extractVersion(from: installedResult.combinedOutput) else {
            let fallbackMessage = installedResult.timedOut
                ? "Timed out while checking installed Codex CLI."
                : conciseMessage(from: installedResult.combinedOutput)
            let message = fallbackMessage.isEmpty
                ? "Codex CLI not found. Install with npm install -g @openai/codex@latest"
                : fallbackMessage
            return CodexUpdateStatus(
                installedVersion: nil,
                latestVersion: nil,
                availability: .notInstalled,
                message: message
            )
        }

        let latestResult = runCommand(
            executable: "/usr/bin/env",
            arguments: ["npm", "view", codexPackageName, "version", "--json"],
            timeout: 12
        )
        guard latestResult.exitCode == 0,
              let latestVersion = extractVersion(from: latestResult.combinedOutput) else {
            return CodexUpdateStatus(
                installedVersion: installedVersion,
                latestVersion: nil,
                availability: .latestUnknown,
                message: "Unable to check latest Codex version right now."
            )
        }

        let needsUpdate = compareSemver(installedVersion, latestVersion) == .orderedAscending
        return CodexUpdateStatus(
            installedVersion: installedVersion,
            latestVersion: latestVersion,
            availability: needsUpdate ? .updateAvailable : .upToDate,
            message: nil
        )
    }

    static func updateToLatest() -> CodexUpdateOperationResult {
        let updateResult = runCommand(
            executable: "/usr/bin/env",
            arguments: ["npm", "install", "-g", "\(codexPackageName)@latest"],
            timeout: 300
        )

        if updateResult.exitCode == 0 {
            let versionResult = runCommand(
                executable: "/usr/bin/env",
                arguments: ["codex", "--version"],
                timeout: 8
            )
            if let version = extractVersion(from: versionResult.combinedOutput) {
                return CodexUpdateOperationResult(
                    success: true,
                    message: "Codex updated to \(version)."
                )
            }
            return CodexUpdateOperationResult(
                success: true,
                message: "Codex update completed."
            )
        }

        let fallback = updateResult.timedOut
            ? "Codex update timed out."
            : "Codex update failed."
        let detail = conciseMessage(from: updateResult.combinedOutput)
        let message = detail.isEmpty ? fallback : detail
        return CodexUpdateOperationResult(success: false, message: message)
    }

    private static func runCommand(
        executable: String,
        arguments: [String],
        timeout: TimeInterval
    ) -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return CommandResult(
                exitCode: -1,
                stdout: "",
                stderr: error.localizedDescription,
                timedOut: false
            )
        }

        var timedOut = false
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }

        if process.isRunning {
            timedOut = true
            process.terminate()
            let killDeadline = Date().addingTimeInterval(1.0)
            while process.isRunning && Date() < killDeadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""

        let exitCode: Int32 = timedOut ? -1 : process.terminationStatus
        return CommandResult(exitCode: exitCode, stdout: stdout, stderr: stderr, timedOut: timedOut)
    }

    private static func extractVersion(from text: String) -> String? {
        guard let match = text.range(of: #"\d+\.\d+\.\d+"#, options: .regularExpression) else {
            return nil
        }
        return String(text[match])
    }

    private static func conciseMessage(from text: String) -> String {
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return String(trimmed.prefix(180))
            }
        }
        return ""
    }

    private static func compareSemver(_ lhs: String, _ rhs: String) -> ComparisonResult {
        guard let left = parseSemver(lhs), let right = parseSemver(rhs) else {
            return .orderedSame
        }
        if left.major != right.major {
            return left.major < right.major ? .orderedAscending : .orderedDescending
        }
        if left.minor != right.minor {
            return left.minor < right.minor ? .orderedAscending : .orderedDescending
        }
        if left.patch != right.patch {
            return left.patch < right.patch ? .orderedAscending : .orderedDescending
        }
        return .orderedSame
    }

    private static func parseSemver(_ version: String) -> (major: Int, minor: Int, patch: Int)? {
        let components = version.split(separator: ".")
        guard components.count == 3,
              let major = Int(components[0]),
              let minor = Int(components[1]),
              let patch = Int(components[2]) else {
            return nil
        }
        return (major, minor, patch)
    }
}
