import Foundation

final class MicCaptureService {
    private(set) var isCapturing = false

    func startCapture() {
        isCapturing = true
    }

    func stopCapture() {
        isCapturing = false
    }
}
