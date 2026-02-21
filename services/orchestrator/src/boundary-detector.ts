import { EventEmitter } from 'node:events';
import type { BoundaryReason } from '@realtimecode/protocol';
import type { RealtimeClient } from './realtime-client.js';
import type { TranscriptAssembler } from './transcript-assembler.js';

export interface BoundaryDetectorEvents {
  'utterance-committed': [transcript: string, reason: BoundaryReason];
  'speech-active': [];
  'speech-inactive': [];
}

export interface BoundaryDetectorConfig {
  vadPauseMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  semanticCues: string[];
}

const DEFAULT_CONFIG: BoundaryDetectorConfig = {
  vadPauseMs: 650,
  minSpeechMs: 250,
  maxUtteranceMs: 12_000,
  semanticCues: [
    'run tests',
    'apply that',
    'do it',
    'go ahead',
    'execute',
    'commit that',
    'save that',
    'run it',
    'build it',
    'deploy it',
  ],
};

export class BoundaryDetector extends EventEmitter<BoundaryDetectorEvents> {
  private readonly config: BoundaryDetectorConfig;
  private readonly assembler: TranscriptAssembler;
  private speechStartTime: number | null = null;
  private speechStopTime: number | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private speaking = false;

  constructor(assembler: TranscriptAssembler, config?: Partial<BoundaryDetectorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.assembler = assembler;
  }

  attach(client: RealtimeClient): void {
    client.on('speech_started', () => this.onSpeechStarted());
    client.on('speech_stopped', () => this.onSpeechStopped());
    client.on('transcription.delta', (text) => this.onTranscriptDelta(text));
    client.on('transcription.completed', (transcript) => this.onTranscriptCompleted(transcript));
  }

  commitHotkey(): void {
    this.commitUtterance('hotkey_release');
  }

  destroy(): void {
    this.clearTimers();
  }

  private onSpeechStarted(): void {
    this.speaking = true;
    this.speechStartTime = Date.now();
    this.clearSilenceTimer();
    this.emit('speech-active');

    this.maxDurationTimer = setTimeout(() => {
      this.commitUtterance('max_duration');
    }, this.config.maxUtteranceMs);
  }

  private onSpeechStopped(): void {
    this.speaking = false;
    this.speechStopTime = Date.now();
    this.emit('speech-inactive');

    const speechDuration = this.getSpeechDurationMs();
    if (speechDuration < this.config.minSpeechMs) {
      this.assembler.reset();
      this.clearTimers();
      return;
    }

    const currentText = this.assembler.peek();
    if (this.matchesSemanticCue(currentText)) {
      this.commitUtterance('semantic_completion');
      return;
    }

    this.silenceTimer = setTimeout(() => {
      this.commitUtterance('silence');
    }, this.config.vadPauseMs);
  }

  private onTranscriptDelta(text: string): void {
    this.assembler.append(text);
  }

  private onTranscriptCompleted(transcript: string): void {
    this.assembler.setFinal(transcript);
  }

  private commitUtterance(reason: BoundaryReason): void {
    this.clearTimers();
    const transcript = this.assembler.commit();
    if (transcript.length > 0) {
      this.emit('utterance-committed', transcript, reason);
    }
    this.speechStartTime = null;
    this.speechStopTime = null;
    this.speaking = false;
  }

  private getSpeechDurationMs(): number {
    if (this.speechStartTime === null) return 0;
    const end = this.speechStopTime ?? Date.now();
    return end - this.speechStartTime;
  }

  private matchesSemanticCue(text: string): boolean {
    if (text.length === 0) return false;
    const lower = text.toLowerCase().trimEnd();
    return this.config.semanticCues.some((cue) => lower.endsWith(cue));
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSilenceTimer();
    if (this.maxDurationTimer !== null) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }
}

// Pure function for simple boundary detection (kept for direct use/tests)
export type BoundaryInput = {
  silenceMs: number;
  clipMs: number;
  hasHotkeyRelease: boolean;
  utteranceMs: number;
};

export function detectBoundary(input: BoundaryInput): BoundaryReason | null {
  if (input.hasHotkeyRelease) {
    return 'hotkey_release';
  }

  if (input.utteranceMs >= 12_000) {
    return 'max_duration';
  }

  if (input.clipMs >= 250 && input.silenceMs >= 650) {
    return 'silence';
  }

  return null;
}
