import Foundation

final class HotkeyManager {
    private(set) var isListening = false

    func startListening() {
        isListening = true
    }

    func stopListening() {
        isListening = false
    }
}
