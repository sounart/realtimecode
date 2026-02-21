import { EventEmitter } from 'node:events';
import type { BoundaryReason } from '@realtimecode/protocol';
import { RealtimeClient, type RealtimeClientOptions } from './realtime-client.js';
import { BoundaryDetector, type BoundaryDetectorConfig } from './boundary-detector.js';
import { TranscriptAssembler } from './transcript-assembler.js';

export type SessionState = 'idle' | 'active' | 'stopped';

export interface SessionManagerEvents {
  'utterance-committed': [transcript: string, reason: BoundaryReason];
  'speech-active': [];
  'speech-inactive': [];
  'transcription-delta': [text: string];
  'session-ready': [];
  'error': [error: Error];
  'closed': [];
}

export interface SessionManagerOptions {
  realtimeClient: RealtimeClientOptions;
  boundaryDetector?: Partial<BoundaryDetectorConfig>;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private activeSessionId: string | null = null;
  private client: RealtimeClient | null = null;
  private detector: BoundaryDetector | null = null;
  private assembler: TranscriptAssembler | null = null;

  get state(): SessionState {
    if (this.activeSessionId === null) return 'idle';
    return this.activeSessionId === 'stopped' ? 'stopped' : 'active';
  }

  get sessionId(): string | null {
    return this.activeSessionId;
  }

  start(options: SessionManagerOptions): string {
    if (this.state === 'active') {
      this.stop();
    }

    this.activeSessionId = `session-${Date.now()}`;

    this.assembler = new TranscriptAssembler();
    this.client = new RealtimeClient(options.realtimeClient);
    this.detector = new BoundaryDetector(this.assembler, options.boundaryDetector);

    this.detector.attach(this.client);

    this.client.on('session.created', () => {
      this.emit('session-ready');
    });

    this.client.on('transcription.delta', (text) => {
      this.emit('transcription-delta', text);
    });

    this.client.on('error', (err) => {
      this.emit('error', err);
    });

    this.client.on('close', () => {
      this.emit('closed');
    });

    this.detector.on('utterance-committed', (transcript, reason) => {
      this.emit('utterance-committed', transcript, reason);
    });

    this.detector.on('speech-active', () => {
      this.emit('speech-active');
    });

    this.detector.on('speech-inactive', () => {
      this.emit('speech-inactive');
    });

    this.client.connect();
    return this.activeSessionId;
  }

  appendAudio(base64Audio: string): void {
    this.client?.appendAudio(base64Audio);
  }

  commitHotkey(): void {
    this.client?.commitAudioBuffer();
    this.detector?.commitHotkey();
  }

  stop(): void {
    this.detector?.destroy();
    this.client?.disconnect();
    this.client = null;
    this.detector = null;
    this.assembler = null;
    this.activeSessionId = 'stopped';
  }
}
