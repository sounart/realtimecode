import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export interface RealtimeClientEvents {
  'session.created': [];
  'speech_started': [];
  'speech_stopped': [];
  'transcription.delta': [text: string];
  'transcription.completed': [transcript: string];
  'error': [error: Error];
  'close': [];
}

export interface RealtimeClientOptions {
  apiKey: string;
  model?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
}

type ServerEvent =
  | { type: 'session.created' }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'conversation.item.input_audio_transcription.completed'; transcript: string }
  | { type: 'conversation.item.input_audio_transcription.delta'; delta: string }
  | { type: 'error'; error: { message: string } };

export class RealtimeClient extends EventEmitter<RealtimeClientEvents> {
  private ws: WebSocket | null = null;
  private readonly options: Required<RealtimeClientOptions>;

  constructor(options: RealtimeClientOptions) {
    super();
    this.options = {
      model: 'gpt-realtime',
      vadThreshold: 0.5,
      silenceDurationMs: 650,
      prefixPaddingMs: 300,
      ...options,
    };
  }

  connect(): void {
    const url = `wss://api.openai.com/v1/realtime?model=${this.options.model}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.ws.on('open', () => {
      this.sendSessionUpdate();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.emit('close');
    });
  }

  appendAudio(base64Audio: string): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio,
    });
  }

  commitAudioBuffer(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  clearAudioBuffer(): void {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private sendSessionUpdate(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'transcription',
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'gpt-4o-transcribe',
        },
        turn_detection: {
          type: 'server_vad',
          threshold: this.options.vadThreshold,
          prefix_padding_ms: this.options.prefixPaddingMs,
          silence_duration_ms: this.options.silenceDurationMs,
        },
      },
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(data)) as ServerEvent;
    } catch {
      this.emit('error', new Error('Failed to parse server message'));
      return;
    }

    switch (event.type) {
      case 'session.created':
        this.emit('session.created');
        break;
      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;
      case 'conversation.item.input_audio_transcription.delta':
        this.emit('transcription.delta', event.delta);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.emit('transcription.completed', event.transcript);
        break;
      case 'error':
        this.emit('error', new Error(event.error.message));
        break;
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}
