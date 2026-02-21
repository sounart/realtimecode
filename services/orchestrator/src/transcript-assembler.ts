export class TranscriptAssembler {
  private parts: string[] = [];

  append(partial: string): void {
    if (partial.trim().length > 0) {
      this.parts.push(partial.trim());
    }
  }

  commit(): string {
    const transcript = this.parts.join(' ').trim();
    this.parts = [];
    return transcript;
  }
}
