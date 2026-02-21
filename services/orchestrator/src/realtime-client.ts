export type PartialTranscriptHandler = (text: string) => void;

export class RealtimeClient {
  constructor(private readonly onPartialTranscript: PartialTranscriptHandler) {}

  receiveMockAudioFrame(frame: string): void {
    this.onPartialTranscript(frame);
  }
}
