import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BoundaryDetector, detectBoundary, type BoundaryInput } from '../boundary-detector.js';
import { TranscriptAssembler } from '../transcript-assembler.js';
import type { RealtimeClient, RealtimeClientEvents } from '../realtime-client.js';

function createMockClient(): EventEmitter<RealtimeClientEvents> {
  return new EventEmitter<RealtimeClientEvents>();
}

describe('detectBoundary (pure function)', () => {
  it('returns hotkey_release when hotkey is pressed', () => {
    const input: BoundaryInput = { silenceMs: 0, clipMs: 0, hasHotkeyRelease: true, utteranceMs: 500 };
    expect(detectBoundary(input)).toBe('hotkey_release');
  });

  it('returns max_duration when utterance exceeds 12s', () => {
    const input: BoundaryInput = { silenceMs: 0, clipMs: 1000, hasHotkeyRelease: false, utteranceMs: 12_000 };
    expect(detectBoundary(input)).toBe('max_duration');
  });

  it('returns silence when clip >= 250ms and silence >= 650ms', () => {
    const input: BoundaryInput = { silenceMs: 650, clipMs: 250, hasHotkeyRelease: false, utteranceMs: 1000 };
    expect(detectBoundary(input)).toBe('silence');
  });

  it('returns null when silence is too short', () => {
    const input: BoundaryInput = { silenceMs: 400, clipMs: 300, hasHotkeyRelease: false, utteranceMs: 1000 };
    expect(detectBoundary(input)).toBeNull();
  });

  it('returns null when clip is too short', () => {
    const input: BoundaryInput = { silenceMs: 700, clipMs: 100, hasHotkeyRelease: false, utteranceMs: 1000 };
    expect(detectBoundary(input)).toBeNull();
  });

  it('prioritizes hotkey over max_duration', () => {
    const input: BoundaryInput = { silenceMs: 700, clipMs: 300, hasHotkeyRelease: true, utteranceMs: 15_000 };
    expect(detectBoundary(input)).toBe('hotkey_release');
  });
});

describe('BoundaryDetector (event-driven)', () => {
  let assembler: TranscriptAssembler;
  let detector: BoundaryDetector;
  let client: EventEmitter<RealtimeClientEvents>;

  beforeEach(() => {
    vi.useFakeTimers();
    assembler = new TranscriptAssembler();
    detector = new BoundaryDetector(assembler, { vadPauseMs: 650, minSpeechMs: 250, maxUtteranceMs: 12_000 });
    client = createMockClient();
    detector.attach(client as unknown as RealtimeClient);
  });

  afterEach(() => {
    detector.destroy();
    vi.useRealTimers();
  });

  it('emits utterance-committed with silence reason after VAD pause', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    vi.advanceTimersByTime(500);
    client.emit('transcription.delta', 'hello world');
    client.emit('speech_stopped');

    expect(committed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(650);
    expect(committed).toHaveBeenCalledWith('hello world', 'silence');
  });

  it('emits utterance-committed with hotkey_release on commitHotkey', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    client.emit('transcription.delta', 'run tests');
    detector.commitHotkey();

    expect(committed).toHaveBeenCalledWith('run tests', 'hotkey_release');
  });

  it('emits utterance-committed with max_duration after 12s', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    client.emit('transcription.delta', 'a really long utterance');
    vi.advanceTimersByTime(12_000);

    expect(committed).toHaveBeenCalledWith('a really long utterance', 'max_duration');
  });

  it('ignores speech shorter than minSpeechMs', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    vi.advanceTimersByTime(100); // Only 100ms of speech
    client.emit('transcription.delta', 'uh');
    client.emit('speech_stopped');

    vi.advanceTimersByTime(1000);
    expect(committed).not.toHaveBeenCalled();
  });

  it('detects semantic completion cues and commits early', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    vi.advanceTimersByTime(500);
    client.emit('transcription.delta', 'please run tests');
    client.emit('speech_stopped');

    // Should commit immediately on semantic cue, not wait for silence timer
    expect(committed).toHaveBeenCalledWith('please run tests', 'semantic_completion');
  });

  it('uses final transcript when available', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    vi.advanceTimersByTime(500);
    client.emit('transcription.delta', 'helo wrld');
    client.emit('transcription.completed', 'hello world');
    client.emit('speech_stopped');

    vi.advanceTimersByTime(650);
    expect(committed).toHaveBeenCalledWith('hello world', 'silence');
  });

  it('emits speech-active and speech-inactive events', () => {
    const active = vi.fn();
    const inactive = vi.fn();
    detector.on('speech-active', active);
    detector.on('speech-inactive', inactive);

    client.emit('speech_started');
    expect(active).toHaveBeenCalledOnce();

    client.emit('speech_stopped');
    expect(inactive).toHaveBeenCalledOnce();
  });

  it('does not emit when transcript is empty', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    client.emit('speech_started');
    vi.advanceTimersByTime(500);
    // No transcript delta
    client.emit('speech_stopped');
    vi.advanceTimersByTime(650);

    expect(committed).not.toHaveBeenCalled();
  });

  it('resets state after commit', () => {
    const committed = vi.fn();
    detector.on('utterance-committed', committed);

    // First utterance
    client.emit('speech_started');
    vi.advanceTimersByTime(500);
    client.emit('transcription.delta', 'first');
    client.emit('speech_stopped');
    vi.advanceTimersByTime(650);

    // Second utterance
    client.emit('speech_started');
    vi.advanceTimersByTime(500);
    client.emit('transcription.delta', 'second');
    client.emit('speech_stopped');
    vi.advanceTimersByTime(650);

    expect(committed).toHaveBeenCalledTimes(2);
    expect(committed).toHaveBeenNthCalledWith(1, 'first', 'silence');
    expect(committed).toHaveBeenNthCalledWith(2, 'second', 'silence');
  });
});
