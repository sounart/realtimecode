import AVFoundation
import Foundation

/// Captures microphone audio and outputs PCM16 24kHz mono frames as base64 strings.
final class MicCaptureService {
    private let audioEngine = AVAudioEngine()
    private var audioConverter: AVAudioConverter?
    private let targetSampleRate: Double = 24000
    private let targetChannels: AVAudioChannelCount = 1

    private(set) var isCapturing = false

    /// Called with base64-encoded PCM16 24kHz mono audio chunks.
    var onAudioChunk: ((String) -> Void)?

    /// Request microphone permission. Calls back on main queue with the result.
    func requestPermission(completion: @escaping (Bool) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            DispatchQueue.main.async { completion(true) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        default:
            DispatchQueue.main.async { completion(false) }
        }
    }

    func startCapture() throws {
        guard !isCapturing else { return }

        let inputNode = audioEngine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NSError(
                domain: "MicCaptureService",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No audio input available"]
            )
        }

        // Target format: PCM16 signed int, 24kHz, mono, interleaved
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: targetChannels,
            interleaved: true
        ) else {
            throw NSError(
                domain: "MicCaptureService",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create target audio format"]
            )
        }

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw NSError(
                domain: "MicCaptureService",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create audio converter"]
            )
        }
        self.audioConverter = converter

        // Buffer size: ~100ms of audio at input sample rate
        let bufferSize: AVAudioFrameCount = AVAudioFrameCount(inputFormat.sampleRate * 0.1)

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) {
            [weak self] buffer, _ in
            self?.processAudioBuffer(buffer)
        }

        try audioEngine.start()
        isCapturing = true
    }

    func stopCapture() {
        guard isCapturing else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        audioConverter = nil
        isCapturing = false
    }

    // MARK: - Audio Processing

    private func processAudioBuffer(_ inputBuffer: AVAudioPCMBuffer) {
        guard let converter = audioConverter else { return }

        // Calculate output frame count based on sample rate ratio
        let ratio = targetSampleRate / inputBuffer.format.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(inputBuffer.frameLength) * ratio)
        guard outputFrameCount > 0 else { return }

        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: converter.outputFormat,
            frameCapacity: outputFrameCount
        ) else { return }

        var error: NSError?
        var consumed = false

        converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return inputBuffer
        }

        if let error = error {
            print("[MicCapture] Conversion error: \(error.localizedDescription)")
            return
        }

        guard outputBuffer.frameLength > 0 else { return }

        // Extract raw Int16 PCM bytes
        guard let int16Data = outputBuffer.int16ChannelData else { return }
        let byteCount = Int(outputBuffer.frameLength) * MemoryLayout<Int16>.size
        let data = Data(bytes: int16Data[0], count: byteCount)
        let base64 = data.base64EncodedString()

        onAudioChunk?(base64)
    }
}
