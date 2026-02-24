import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transcriber } from '../transcriber.js';

class FakeSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close');
  }
}

function parsePayload(payload: string): Record<string, unknown> {
  return JSON.parse(payload) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Transcriber', () => {
  it('uses GA websocket defaults with model query and no beta header', () => {
    let capturedUrl = '';
    let capturedOptions: object | undefined;
    const socketFactory = (url: string, options?: object) => {
      capturedUrl = url;
      capturedOptions = options;
      return new FakeSocket() as unknown as WebSocket;
    };

    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
        onReady: vi.fn(),
      },
    );

    transcriber.connect();

    expect(capturedUrl).toBe('wss://api.openai.com/v1/realtime?model=gpt-4o-transcribe');
    expect(capturedOptions).toEqual({
      headers: {
        Authorization: 'Bearer test',
      },
    });
  });

  it('supports env-configured transcription model and language', () => {
    vi.stubEnv('RTC_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe');
    vi.stubEnv('RTC_TRANSCRIBE_LANGUAGE', 'en');

    const sockets: FakeSocket[] = [];
    let capturedUrl = '';
    const socketFactory = (url: string) => {
      capturedUrl = url;
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    };

    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
        onReady: vi.fn(),
      },
    );

    transcriber.connect();
    const socket = sockets[0];
    socket.readyState = FakeSocket.OPEN;
    socket.emit('open');

    expect(capturedUrl).toBe('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-transcribe');
    const update = parsePayload(socket.sent[0]);
    expect(update.type).toBe('session.update');
    expect(update.session).toMatchObject({
      audio: {
        input: {
          transcription: {
            model: 'gpt-4o-mini-transcribe',
            language: 'en',
          },
        },
      },
    });
  });

  it('blocks custom realtime URLs unless explicitly allowed', () => {
    vi.stubEnv('RTC_REALTIME_URL', 'wss://example.com/v1/realtime');

    let capturedUrl = '';
    const socketFactory = (url: string) => {
      capturedUrl = url;
      return new FakeSocket() as unknown as WebSocket;
    };

    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
        onReady: vi.fn(),
      },
    );

    transcriber.connect();
    expect(capturedUrl).toBe('wss://api.openai.com/v1/realtime?model=gpt-4o-transcribe');
  });

  it('allows custom realtime URLs when RTC_ALLOW_CUSTOM_REALTIME_URL=1', () => {
    vi.stubEnv('RTC_REALTIME_URL', 'wss://example.com/v1/realtime');
    vi.stubEnv('RTC_ALLOW_CUSTOM_REALTIME_URL', '1');

    let capturedUrl = '';
    const socketFactory = (url: string) => {
      capturedUrl = url;
      return new FakeSocket() as unknown as WebSocket;
    };

    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError: vi.fn(),
        onReady: vi.fn(),
      },
    );

    transcriber.connect();
    expect(capturedUrl).toBe('wss://example.com/v1/realtime');
  });

  it('buffers early audio and flushes after session update', () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    };

    const onReady = vi.fn();
    const onError = vi.fn();
    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
        onReady,
      },
    );

    transcriber.connect();
    expect(sockets).toHaveLength(1);

    const socket = sockets[0];

    // Send audio before websocket is fully ready; this should be buffered.
    transcriber.sendAudio('chunk-a');
    expect(socket.sent).toHaveLength(0);

    socket.readyState = FakeSocket.OPEN;
    socket.emit('open');

    expect(socket.sent).toHaveLength(1);
    expect(parsePayload(socket.sent[0]).type).toBe('session.update');

    // Still buffered until session update event arrives.
    expect(socket.sent).toHaveLength(1);

    socket.emit('message', JSON.stringify({ type: 'session.updated' }));

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(socket.sent).toHaveLength(2);
    expect(parsePayload(socket.sent[1]).type).toBe('input_audio_buffer.append');
    expect(parsePayload(socket.sent[1]).audio).toBe('chunk-a');
    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards server errors instead of sending legacy beta updates', () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    };

    const onError = vi.fn();
    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
        onReady: vi.fn(),
      },
    );

    transcriber.connect();
    const socket = sockets[0];
    socket.readyState = FakeSocket.OPEN;
    socket.emit('open');

    expect(parsePayload(socket.sent[0]).type).toBe('session.update');

    socket.emit('message', JSON.stringify({ type: 'error', message: 'Unknown event type: session.update' }));

    expect(socket.sent).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Unknown event type: session.update' }),
    );
  });

  it('emits final transcripts in commit order when completion events arrive out of order', () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    };

    const onFinalTranscript = vi.fn();
    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript,
        onError: vi.fn(),
        onReady: vi.fn(),
      },
    );

    transcriber.connect();
    const socket = sockets[0];
    socket.readyState = FakeSocket.OPEN;
    socket.emit('open');
    socket.emit('message', JSON.stringify({ type: 'session.updated' }));

    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item-1' }));
    socket.emit('message', JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'item-2' }));

    // Out-of-order completions.
    socket.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-2',
      transcript: 'second',
    }));
    socket.emit('message', JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'first',
    }));

    expect(onFinalTranscript).toHaveBeenNthCalledWith(1, 'first');
    expect(onFinalTranscript).toHaveBeenNthCalledWith(2, 'second');
  });

  it('reports reconnect exhaustion after repeated close events', () => {
    vi.useFakeTimers();

    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    };

    const onError = vi.fn();
    const transcriber = new Transcriber(
      { apiKey: 'test', socketFactory },
      {
        onPartialTranscript: vi.fn(),
        onFinalTranscript: vi.fn(),
        onError,
        onReady: vi.fn(),
      },
    );

    transcriber.connect();

    for (let i = 0; i < 6; i += 1) {
      const socket = sockets[i];
      expect(socket).toBeDefined();
      socket.emit('close');
      vi.runOnlyPendingTimers();
    }

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Realtime websocket reconnect attempts exhausted' }),
    );
  });
});
