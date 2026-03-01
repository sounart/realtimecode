import WebSocket from 'ws';
import { logger } from './logger.js';
import {
  DEFAULT_REALTIME_URL_BASE,
  DEFAULT_REALTIME_SESSION_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_MODEL_PATTERN,
  MAX_PENDING_AUDIO_CHUNKS,
  MAX_TRACKED_EMITTED_ITEMS,
  DEFAULT_VAD_THRESHOLD,
  DEFAULT_SILENCE_DURATION_MS,
  DEFAULT_PREFIX_PADDING_MS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
} from './config.js';

export interface TranscriberCallbacks {
  onPartialTranscript: (text: string) => void;
  onFinalTranscript: (text: string) => void;
  onError: (error: Error) => void;
  onReady: () => void;
}

interface TranscriberOptions {
  apiKey: string;
  model?: string;
  language?: string;
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

function resolveRealtimeUrl(rawUrl: string | undefined, sessionModel: string): string {
  const fallback = `${DEFAULT_REALTIME_URL_BASE}?model=${encodeURIComponent(sessionModel)}`;
  if (!rawUrl) return fallback;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    logger.warn('invalid RTC_REALTIME_URL; using default realtime endpoint');
    return fallback;
  }

  if (parsed.protocol !== 'wss:') {
    logger.warn('RTC_REALTIME_URL must use wss://; using default realtime endpoint', {
      protocol: parsed.protocol,
    });
    return fallback;
  }

  const allowCustom = process.env['RTC_ALLOW_CUSTOM_REALTIME_URL'] === '1';
  if (!allowCustom) {
    const isDefaultHost = parsed.hostname === 'api.openai.com';
    const isDefaultPath = parsed.pathname === '/v1/realtime';
    if (!isDefaultHost || !isDefaultPath) {
      logger.warn('custom realtime URL blocked; set RTC_ALLOW_CUSTOM_REALTIME_URL=1 to override', {
        host: parsed.hostname,
        path: parsed.pathname,
      });
      return fallback;
    }
  }

  if (!parsed.searchParams.get('model')) {
    parsed.searchParams.set('model', sessionModel);
  }

  return parsed.toString();
}

function normalizeRealtimeSessionModel(rawModel: string | undefined): string {
  const trimmed = rawModel?.trim();
  if (!trimmed) return DEFAULT_REALTIME_SESSION_MODEL;

  if (trimmed === 'whisper-1' || trimmed.includes('transcribe')) {
    logger.warn('invalid realtime session model; using default', {
      requestedModel: trimmed,
      fallbackModel: DEFAULT_REALTIME_SESSION_MODEL,
    });
    return DEFAULT_REALTIME_SESSION_MODEL;
  }

  return trimmed;
}

function normalizeTranscriptionModel(rawModel: string | undefined): string {
  const trimmed = rawModel?.trim();
  if (!trimmed) return DEFAULT_TRANSCRIPTION_MODEL;
  if (TRANSCRIPTION_MODEL_PATTERN.test(trimmed)) return trimmed;

  logger.warn('invalid transcription model; using default', {
    requestedModel: trimmed,
    fallbackModel: DEFAULT_TRANSCRIPTION_MODEL,
  });
  return DEFAULT_TRANSCRIPTION_MODEL;
}

export class Transcriber {
  private static readonly AUDIO_APPEND_PREFIX = '{"type":"input_audio_buffer.append","audio":"';
  private static readonly AUDIO_APPEND_SUFFIX = '"}';

  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly transcriptionModel: string;
  private readonly realtimeSessionModel: string;
  private readonly language: string | null;
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

  private committedItemOrder: string[] = [];
  private committedItemHead = 0;
  private committedItems = new Set<string>();
  private completedByItem = new Map<string, string>();
  private failedByItem = new Map<string, string>();
  private emittedItemIds = new Set<string>();
  private emittedItemOrder: string[] = [];
  private emittedItemHead = 0;

  private cb: TranscriberCallbacks;

  constructor(options: TranscriberOptions, callbacks: TranscriberCallbacks) {
    this.apiKey = options.apiKey;
    this.transcriptionModel = normalizeTranscriptionModel(
      options.model ?? process.env['RTC_TRANSCRIBE_MODEL'],
    );
    this.realtimeSessionModel = normalizeRealtimeSessionModel(
      process.env['RTC_REALTIME_SESSION_MODEL']
      ?? process.env['RTC_REALTIME_MODEL'],
    );
    this.language = options.language ?? process.env['RTC_TRANSCRIBE_LANGUAGE'] ?? null;
    this.vadThreshold = options.vadThreshold ?? DEFAULT_VAD_THRESHOLD;
    this.silenceDurationMs = options.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS;
    this.prefixPaddingMs = options.prefixPaddingMs ?? DEFAULT_PREFIX_PADDING_MS;
    this.socketFactory = options.socketFactory
      ?? ((url: string, wsOptions?: object) => new WebSocket(url, wsOptions as never));
    this.realtimeUrl = resolveRealtimeUrl(process.env['RTC_REALTIME_URL'], this.realtimeSessionModel);
    this.cb = callbacks;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.shouldReconnect = true;
    this.sessionReady = false;
    this.resetTranscriptOrdering();

    const ws = this.socketFactory(this.realtimeUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
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
      this.sendAudioChunk(base64);
      return;
    }

    // Buffer early audio while websocket/session handshake completes.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.pendingAudioChunks.length >= MAX_PENDING_AUDIO_CHUNKS) {
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
    this.committedItemHead = 0;
    this.committedItems.clear();
    this.completedByItem.clear();
    this.failedByItem.clear();
    this.emittedItemIds.clear();
    this.emittedItemOrder = [];
    this.emittedItemHead = 0;
  }

  private sendSessionUpdate(): void {
    const transcription: Record<string, unknown> = { model: this.transcriptionModel };
    if (this.language) {
      transcription['language'] = this.language;
    }

    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            transcription,
            turn_detection: {
              type: 'server_vad',
              threshold: this.vadThreshold,
              prefix_padding_ms: this.prefixPaddingMs,
              silence_duration_ms: this.silenceDurationMs,
              create_response: false,
              interrupt_response: false,
            },
            noise_reduction: { type: 'near_field' },
          },
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

    this.markItemEmitted(itemId);
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
    while (this.committedItemHead < this.committedItemOrder.length) {
      const nextItem = this.committedItemOrder[this.committedItemHead];
      if (!nextItem) break;

      const failed = this.failedByItem.get(nextItem);
      if (failed) {
        this.failedByItem.delete(nextItem);
        this.completedByItem.delete(nextItem);
        this.committedItems.delete(nextItem);
        this.markItemEmitted(nextItem);
        this.committedItemHead += 1;
        this.cb.onError(new Error(failed));
        continue;
      }

      const transcript = this.completedByItem.get(nextItem);
      if (!transcript) break;

      this.completedByItem.delete(nextItem);
      this.committedItems.delete(nextItem);
      this.markItemEmitted(nextItem);
      this.committedItemHead += 1;
      this.cb.onFinalTranscript(transcript);
    }

    if (this.committedItemHead > 0 && this.committedItemHead * 2 >= this.committedItemOrder.length) {
      this.committedItemOrder = this.committedItemOrder.slice(this.committedItemHead);
      this.committedItemHead = 0;
    }
  }

  private flushPendingAudio(): void {
    if (!this.sessionReady || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.pendingAudioChunks.length === 0) {
      return;
    }

    const queuedChunks = this.pendingAudioChunks;
    this.pendingAudioChunks = [];
    for (const chunk of queuedChunks) {
      this.sendAudioChunk(chunk);
    }
  }

  private handleErrorEvent(event: Record<string, unknown>): void {
    const message = getErrorMessage(event);
    this.cb.onError(new Error(message));
  }

  private markItemEmitted(itemId: string): void {
    if (!itemId || this.emittedItemIds.has(itemId)) return;

    this.emittedItemIds.add(itemId);
    this.emittedItemOrder.push(itemId);

    const trackedCount = this.emittedItemOrder.length - this.emittedItemHead;
    if (trackedCount <= MAX_TRACKED_EMITTED_ITEMS) return;

    const overflow = trackedCount - MAX_TRACKED_EMITTED_ITEMS;
    for (let i = 0; i < overflow; i += 1) {
      const staleId = this.emittedItemOrder[this.emittedItemHead];
      this.emittedItemHead += 1;
      if (staleId) this.emittedItemIds.delete(staleId);
    }

    if (this.emittedItemHead * 2 >= this.emittedItemOrder.length) {
      this.emittedItemOrder = this.emittedItemOrder.slice(this.emittedItemHead);
      this.emittedItemHead = 0;
    }
  }

  private sendAudioChunk(base64: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Transcriber.AUDIO_APPEND_PREFIX + base64 + Transcriber.AUDIO_APPEND_SUFFIX);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.cb.onError(new Error('Realtime websocket reconnect attempts exhausted'));
      return;
    }

    this.reconnectAttempts += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.connect();
    }, delayMs);
  }
}
