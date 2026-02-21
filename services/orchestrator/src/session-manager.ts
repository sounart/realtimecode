import type {
  BoundaryReason,
  InstructionSubmitResponse,
  SessionStartResponse,
  SparkProfile,
  StreamEvent,
  UtteranceMetadata
} from '@realtimecode/protocol';
import { logger } from '@realtimecode/shared';
import { BoundaryDetector } from './boundary-detector.js';
import { evaluateInstruction } from './policy-engine.js';
import { RealtimeClient } from './realtime-client.js';
import { SparkBridge } from './spark-bridge.js';
import { TranscriptAssembler } from './transcript-assembler.js';

export type OrchestratorState = 'idle' | 'listening' | 'transcribing' | 'executing';

export type SessionStatus = {
  sessionId: string | null;
  state: OrchestratorState;
  workdir: string | null;
};

export class SessionManager {
  private orchestratorState: OrchestratorState = 'idle';
  private realtimeClient: RealtimeClient | null = null;
  private boundaryDetector: BoundaryDetector | null = null;
  private spark: SparkBridge | null = null;
  private assembler = new TranscriptAssembler();
  private sessionId: string | null = null;
  private workdir: string | null = null;
  private activeInstructionId: string | null = null;
  private utteranceStartMs = 0;
  private lastPartialMs = 0;
  private handlers: Array<(event: StreamEvent) => void> = [];

  onEvent(handler: (event: StreamEvent) => void): void {
    this.handlers.push(handler);
  }

  private broadcast(event: StreamEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private broadcastStatus(): void {
    if (!this.sessionId) {
      return;
    }

    this.broadcast({
      type: 'status',
      sessionId: this.sessionId,
      state: this.orchestratorState === 'idle'
        ? 'idle'
        : this.orchestratorState === 'listening'
          ? 'listening'
          : this.orchestratorState === 'transcribing'
            ? 'transcribing'
            : 'executing',
      timestamp: new Date().toISOString()
    });
  }

  startSession(workdir: string, profile: SparkProfile): SessionStartResponse {
    if (this.orchestratorState !== 'idle') {
      throw new Error('Session already active');
    }

    this.sessionId = `session-${Date.now()}`;
    this.workdir = workdir;

    this.spark = new SparkBridge();
    this.spark.onEvent((event) => {
      this.broadcast(event);

      if (!this.spark?.isExecuting && this.orchestratorState === 'executing') {
        this.orchestratorState = 'listening';
        this.activeInstructionId = null;
        this.broadcastStatus();
      }
    });
    this.spark.startSession(workdir);

    // Initialize audio pipeline: RealtimeClient → BoundaryDetector → commitUtterance
    this.assembler = new TranscriptAssembler();

    const apiKey = process.env.OPENAI_API_KEY ?? '';
    this.realtimeClient = new RealtimeClient({ apiKey });

    this.boundaryDetector = new BoundaryDetector(this.assembler);
    this.boundaryDetector.attach(this.realtimeClient);

    this.realtimeClient.on('transcription.delta', (text: string) => {
      this.handlePartialTranscript(text);
    });

    this.realtimeClient.on('error', (err: Error) => {
      logger.warn({ error: err.message }, 'realtime client error');
    });

    this.boundaryDetector.on('utterance-committed', (transcript: string, reason: BoundaryReason) => {
      this.handleCommittedUtterance(transcript, reason);
    });

    this.boundaryDetector.on('speech-active', () => {
      if (this.orchestratorState === 'executing' && this.activeInstructionId && this.spark) {
        logger.info({ instructionId: this.activeInstructionId }, 'cancelling active instruction due to new speech');
        this.spark.cancelInstruction(this.activeInstructionId);
        this.activeInstructionId = null;
      }
    });

    if (apiKey) {
      this.realtimeClient.connect();
    } else {
      logger.warn('OPENAI_API_KEY not set — realtime client not connected');
    }

    this.orchestratorState = 'listening';
    this.broadcastStatus();

    logger.info({ sessionId: this.sessionId, workdir, profile }, 'session started');

    return {
      sessionId: this.sessionId,
      workdir,
      profile,
      acceptedAt: new Date().toISOString()
    };
  }

  stopSession(): void {
    this.boundaryDetector?.destroy();
    this.boundaryDetector = null;
    this.realtimeClient?.disconnect();
    this.realtimeClient = null;
    this.spark?.stopSession();
    this.spark = null;
    this.assembler = new TranscriptAssembler();
    this.activeInstructionId = null;

    const prevSessionId = this.sessionId;
    this.sessionId = null;
    this.workdir = null;
    this.orchestratorState = 'idle';

    if (prevSessionId) {
      this.broadcast({
        type: 'status',
        sessionId: prevSessionId,
        state: 'idle',
        timestamp: new Date().toISOString()
      });
    }

    logger.info('session stopped');
  }

  getStatus(): SessionStatus {
    return {
      sessionId: this.sessionId,
      state: this.orchestratorState,
      workdir: this.workdir
    };
  }

  appendAudio(base64Audio: string): void {
    this.realtimeClient?.appendAudio(base64Audio);
  }

  commitHotkey(): void {
    this.realtimeClient?.commitAudioBuffer();
    this.boundaryDetector?.commitHotkey();
  }

  cancelInstruction(id: string): boolean {
    if (!this.spark) {
      return false;
    }

    const cancelled = this.spark.cancelInstruction(id);

    if (cancelled) {
      this.activeInstructionId = null;
      this.orchestratorState = 'listening';
      this.broadcastStatus();
    }

    return cancelled;
  }

  submitText(text: string, metadata: UtteranceMetadata): InstructionSubmitResponse {
    if (!this.spark || this.orchestratorState === 'idle') {
      throw new Error('No active session');
    }

    const decision = evaluateInstruction(text);

    if (!decision.allowed) {
      this.broadcast({
        type: 'error',
        message: decision.reason ?? 'Instruction blocked by policy',
        code: 'POLICY_BLOCKED',
        recoverable: true,
        timestamp: new Date().toISOString()
      });

      return { instructionId: '', queued: false };
    }

    if (this.activeInstructionId) {
      this.spark.cancelInstruction(this.activeInstructionId);
    }

    this.orchestratorState = 'executing';
    this.broadcastStatus();

    this.activeInstructionId = this.spark.submitInstruction(text, metadata);

    return { instructionId: this.activeInstructionId, queued: true };
  }

  handlePartialTranscript(text: string): void {
    const ts = Date.now();

    if (this.orchestratorState === 'executing' && this.activeInstructionId && this.spark) {
      logger.info(
        { instructionId: this.activeInstructionId },
        'cancelling active instruction due to new speech'
      );
      this.spark.cancelInstruction(this.activeInstructionId);
      this.activeInstructionId = null;
    }

    if (this.orchestratorState === 'listening' || this.orchestratorState === 'executing') {
      this.orchestratorState = 'transcribing';
      this.utteranceStartMs = ts;
      this.broadcastStatus();
    }

    // Note: assembler.append is handled by BoundaryDetector.onTranscriptDelta
    this.lastPartialMs = ts;

    this.broadcast({
      type: 'transcript',
      text,
      final: false,
      timestamp: new Date(ts).toISOString()
    });
  }

  commitManual(): void {
    if (this.orchestratorState === 'transcribing') {
      this.boundaryDetector?.commitHotkey();
    }
  }

  private handleCommittedUtterance(transcript: string, reason: BoundaryReason): void {
    logger.info({ transcript, reason }, 'boundary detector committed utterance');

    this.broadcast({
      type: 'transcript',
      text: transcript,
      final: true,
      timestamp: new Date().toISOString()
    });

    const decision = evaluateInstruction(transcript);

    if (!decision.allowed) {
      this.broadcast({
        type: 'error',
        message: decision.reason ?? 'Instruction blocked by policy',
        code: 'POLICY_BLOCKED',
        recoverable: true,
        timestamp: new Date().toISOString()
      });
      this.orchestratorState = 'listening';
      this.broadcastStatus();
      return;
    }

    if (!this.spark) {
      this.orchestratorState = 'listening';
      this.broadcastStatus();
      return;
    }

    this.orchestratorState = 'executing';
    this.broadcastStatus();

    const metadata: UtteranceMetadata = {
      timestamp: new Date().toISOString(),
      confidence: 1.0,
      boundaryReason: reason
    };

    this.activeInstructionId = this.spark.submitInstruction(transcript, metadata);
  }

}
