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
}

type ServerEvent =
  | { type: 'transcription_session.created' | 'session.created' }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'conversation.item.input_audio_transcription.completed'; transcript: string }
  | { type: 'conversation.item.input_audio_transcription.delta'; delta: string }
  | { type: 'response.audio_transcript.delta'; delta: string }
  | { type: 'response.audio_transcript.done'; transcript: string }
  | { type: 'error'; error?: { message?: string }; message?: string }
  | { type: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class Transcriber {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly vadThreshold: number;
  private readonly silenceDurationMs: number;
  private readonly prefixPaddingMs: number;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private attemptedLegacyUpdate = false;
  private cb: TranscriberCallbacks;

  constructor(options: TranscriberOptions, callbacks: TranscriberCallbacks) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gpt-4o-transcribe';
    this.vadThreshold = options.vadThreshold ?? 0.5;
    this.silenceDurationMs = options.silenceDurationMs ?? 800;
    this.prefixPaddingMs = options.prefixPaddingMs ?? 300;
    this.cb = callbacks;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.shouldReconnect = true;
    this.attemptedLegacyUpdate = false;

    const ws = new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
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
      this.scheduleReconnect();
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
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
    this.send({ type: 'input_audio_buffer.append', audio: base64 });
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private sendSessionUpdate(): void {
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

  private sendLegacySessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'transcription',
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
      case 'session.created':
        this.cb.onReady();
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
        if (transcript) this.cb.onFinalTranscript(transcript);
        break;
      }
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

  private handleErrorEvent(event: Record<string, unknown>): void {
    const errorField = event.error;
    const nestedMsg = isRecord(errorField) && typeof errorField.message === 'string' ? errorField.message : null;
    const directMsg = typeof event.message === 'string' ? event.message : null;
    const message = nestedMsg ?? directMsg ?? 'Unknown realtime error';

    if (!this.attemptedLegacyUpdate && message.toLowerCase().includes('transcription_session.update')) {
      this.attemptedLegacyUpdate = true;
      this.sendLegacySessionUpdate();
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
