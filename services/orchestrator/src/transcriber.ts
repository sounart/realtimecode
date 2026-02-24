import WebSocket from 'ws';

export interface TranscriberCallbacks {
  onPartialTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (error: Error) => void;
  onReady: () => void;
}

interface TranscriberOptions {
  apiKey: string;
  model?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  socketFactory?: SocketFactory;
}

type SocketFactory = (
  url: string,
  options?: object,
) => WebSocket;

type ServerEvent =
  | { type: 'transcription_session.created' | 'transcription_session.updated' | 'session.created' | 'session.updated' }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'input_audio_buffer.committed'; item_id?: string; previous_item_id?: string | null }
  | { type: 'conversation.item.input_audio_transcription.completed'; item_id?: string; transcript: string }
  | { type: 'conversation.item.input_audio_transcription.delta'; delta: string }
  | { type: 'conversation.item.input_audio_transcription.failed'; item_id?: string; error?: { message?: string }; message?: string }
  | { type: 'response.audio_transcript.delta'; delta: string }
  | { type: 'response.audio_transcript.done'; item_id?: string; transcript: string }
  | { type: 'error'; error?: { message?: string }; message?: string }
  | { type: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function getErrorMessage(event: Record<string, unknown>): string {
  const errorField = event.error;
  const nestedMsg = isRecord(errorField) && typeof errorField.message === 'string' ? errorField.message : null;
  const directMsg = typeof event.message === 'string' ? event.message : null;
  return nestedMsg ?? directMsg ?? 'Unknown realtime error';
}

export class Transcriber {
  private static readonly MAX_PENDING_AUDIO_CHUNKS = 64;

  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly vadThreshold: number;
  private readonly silenceDurationMs: number;
  private readonly prefixPaddingMs: number;
  private readonly socketFactory: SocketFactory;
  private readonly realtimeUrl: string;

  private sessionReady = false;
  private pendingAudioChunks: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private attemptedLegacyUpdate = false;

  private committedItemOrder: string[] = [];
  private committedItems = new Set<string>();
  private completedByItem = new Map<string, string>();
  private failedByItem = new Map<string, string>();
  private emittedItemIds = new Set<string>();

  private cb: TranscriberCallbacks;

  constructor(options: TranscriberOptions, callbacks: TranscriberCallbacks) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gpt-4o-transcribe';
    this.vadThreshold = options.vadThreshold ?? 0.5;
    this.silenceDurationMs = options.silenceDurationMs ?? 800;
    this.prefixPaddingMs = options.prefixPaddingMs ?? 300;
    this.socketFactory = options.socketFactory
      ?? ((url: string, wsOptions?: object) => new WebSocket(url, wsOptions as never));
    this.realtimeUrl = process.env['RTC_REALTIME_URL'] ?? 'wss://api.openai.com/v1/realtime';
    this.cb = callbacks;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.shouldReconnect = true;
    this.attemptedLegacyUpdate = false;
    this.sessionReady = false;
    this.resetTranscriptOrdering();

    const ws = this.socketFactory(this.realtimeUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.sendSessionUpdate();
    });

    ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));

    ws.on('error', (err: Error) => {
      this.cb.onError(err);
      this.scheduleReconnect();
    });

    ws.on('close', () => {
      this.ws = null;
      this.sessionReady = false;
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.sessionReady = false;
    this.pendingAudioChunks = [];
    this.resetTranscriptOrdering();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  sendAudio(base64: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionReady) {
      this.send({ type: 'input_audio_buffer.append', audio: base64 });
      return;
    }

    // Buffer early audio while websocket/session handshake completes.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.pendingAudioChunks.length >= Transcriber.MAX_PENDING_AUDIO_CHUNKS) {
        this.pendingAudioChunks.shift();
      }
      this.pendingAudioChunks.push(base64);
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private resetTranscriptOrdering(): void {
    this.committedItemOrder = [];
    this.committedItems.clear();
    this.completedByItem.clear();
    this.failedByItem.clear();
    this.emittedItemIds.clear();
  }

  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription: { model: this.model },
            turn_detection: {
              type: 'server_vad',
              threshold: this.vadThreshold,
              prefix_padding_ms: this.prefixPaddingMs,
              silence_duration_ms: this.silenceDurationMs,
            },
            noise_reduction: { type: 'near_field' },
          },
        },
      },
    });
  }

  private sendLegacySessionUpdate(): void {
    this.send({
      type: 'transcription_session.update',
      session: {
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: this.model },
        turn_detection: {
          type: 'server_vad',
          threshold: this.vadThreshold,
          prefix_padding_ms: this.prefixPaddingMs,
          silence_duration_ms: this.silenceDurationMs,
        },
      },
    });
  }

  private markReady(): void {
    if (this.sessionReady) return;
    this.sessionReady = true;
    this.flushPendingAudio();
    this.cb.onReady();
  }

  private handleMessage(data: WebSocket.Data): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.cb.onError(new Error('Failed to parse server message'));
      return;
    }

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      this.cb.onError(new Error('Realtime event missing type'));
      return;
    }

    const event = parsed as ServerEvent;

    switch (event.type) {
      case 'transcription_session.created':
      case 'transcription_session.updated':
      case 'session.updated':
        this.markReady();
        break;
      case 'session.created':
        break;
      case 'input_audio_buffer.committed':
        this.handleCommittedEvent(parsed as Record<string, unknown>);
        break;
      case 'conversation.item.input_audio_transcription.delta':
      case 'response.audio_transcript.delta': {
        const raw = parsed as Record<string, unknown>;
        const delta = typeof raw.delta === 'string' ? raw.delta : '';
        if (delta) this.cb.onPartialTranscript(delta);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
      case 'response.audio_transcript.done': {
        const raw = parsed as Record<string, unknown>;
        const transcript = typeof raw.transcript === 'string' ? raw.transcript : '';
        const itemId = typeof raw.item_id === 'string' ? raw.item_id : '';
        if (transcript) this.handleCompletedTranscript(itemId, transcript);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        this.handleFailedTranscript(parsed as Record<string, unknown>);
        break;
      case 'error':
        this.handleErrorEvent(event as Record<string, unknown>);
        break;
      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech_stopped':
        break; // VAD events — no action needed
      default:
        break;
    }
  }

  private handleCommittedEvent(event: Record<string, unknown>): void {
    const itemId = typeof event.item_id === 'string' ? event.item_id : '';
    if (!itemId) return;
    if (this.emittedItemIds.has(itemId) || this.committedItems.has(itemId)) return;

    this.committedItems.add(itemId);
    this.committedItemOrder.push(itemId);
    this.flushCommittedResults();
  }

  private handleCompletedTranscript(itemId: string, transcript: string): void {
    if (itemId && this.committedItems.has(itemId)) {
      this.completedByItem.set(itemId, transcript);
      this.flushCommittedResults();
      return;
    }

    if (itemId) this.emittedItemIds.add(itemId);
    this.cb.onFinalTranscript(transcript);
  }

  private handleFailedTranscript(event: Record<string, unknown>): void {
    const itemId = typeof event.item_id === 'string' ? event.item_id : '';
    const message = getErrorMessage(event);

    if (itemId && this.committedItems.has(itemId)) {
      this.failedByItem.set(itemId, message);
      this.flushCommittedResults();
      return;
    }

    this.cb.onError(new Error(message));
  }

  private flushCommittedResults(): void {
    while (this.committedItemOrder.length > 0) {
      const nextItem = this.committedItemOrder[0];
      if (!nextItem) break;

      const failed = this.failedByItem.get(nextItem);
      if (failed) {
        this.failedByItem.delete(nextItem);
        this.completedByItem.delete(nextItem);
        this.committedItems.delete(nextItem);
        this.emittedItemIds.add(nextItem);
        this.committedItemOrder.shift();
        this.cb.onError(new Error(failed));
        continue;
      }

      const transcript = this.completedByItem.get(nextItem);
      if (!transcript) break;

      this.completedByItem.delete(nextItem);
      this.committedItems.delete(nextItem);
      this.emittedItemIds.add(nextItem);
      this.committedItemOrder.shift();
      this.cb.onFinalTranscript(transcript);
    }
  }

  private flushPendingAudio(): void {
    while (this.sessionReady && this.ws && this.ws.readyState === WebSocket.OPEN && this.pendingAudioChunks.length > 0) {
      const chunk = this.pendingAudioChunks.shift();
      if (chunk) {
        this.send({ type: 'input_audio_buffer.append', audio: chunk });
      }
    }
  }

  private handleErrorEvent(event: Record<string, unknown>): void {
    const message = getErrorMessage(event);
    const lower = message.toLowerCase();

    if (!this.attemptedLegacyUpdate && (lower.includes('session.update') || lower.includes('audio.input'))) {
      this.attemptedLegacyUpdate = true;
      this.sessionReady = false;
      this.sendLegacySessionUpdate();
      return;
    }

    this.cb.onError(new Error(message));
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    if (this.reconnectAttempts >= 5) {
      this.cb.onError(new Error('Realtime websocket reconnect attempts exhausted'));
      return;
    }

    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30_000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.connect();
    }, delayMs);
  }
}
