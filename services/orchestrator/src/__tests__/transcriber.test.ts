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
});

describe('Transcriber', () => {
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

  it('falls back to legacy transcription_session.update when session.update is rejected', () => {
    const sockets: FakeSocket[] = [];
    const socketFactory = () => {
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

    expect(parsePayload(socket.sent[0]).type).toBe('session.update');

    socket.emit('message', JSON.stringify({ type: 'error', message: 'Unknown event type: session.update' }));

    expect(socket.sent).toHaveLength(2);
    expect(parsePayload(socket.sent[1]).type).toBe('transcription_session.update');
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
