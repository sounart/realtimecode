export class TranscriptAssembler {
  private parts: string[] = [];
  private finalTranscript: string | null = null;

  append(partial: string): void {
    if (partial.trim().length > 0) {
      this.parts.push(partial.trim());
    }
  }

  setFinal(transcript: string): void {
    this.finalTranscript = transcript.trim();
  }

  peek(): string {
    if (this.finalTranscript !== null) {
      return this.finalTranscript;
    }
    return this.parts.join(' ').trim();
  }

  commit(): string {
    const transcript = this.finalTranscript ?? this.parts.join(' ').trim();
    this.reset();
    return transcript;
  }

  reset(): void {
    this.parts = [];
    this.finalTranscript = null;
  }
}
