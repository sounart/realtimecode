import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner, type CodexCallbacks } from '../codex.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    const closeSignal = typeof signal === 'string' ? signal : null;
    this.emit('close', null, closeSignal);
    return true;
  });
}

const spawnQueue: FakeProcess[] = [];

function queueProcess(): FakeProcess {
  const proc = new FakeProcess();
  spawnQueue.push(proc);
  return proc;
}

function callbacks(): CodexCallbacks {
  return {
    onToolCall: vi.fn(),
    onFileChange: vi.fn(),
    onOutput: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  spawnQueue.length = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const proc = spawnQueue.shift();
    if (!proc) {
      throw new Error('No queued fake process for spawn');
    }
    return proc as unknown as ChildProcess;
  });
});

describe('CodexRunner', () => {
  it('spawns codex with stdin prompt and defaults to ephemeral mode', () => {
    const proc = queueProcess();
    const runner = new CodexRunner();
    const cb = callbacks();
    const stdinChunks: Buffer[] = [];
    proc.stdin.on('data', (chunk) => stdinChunks.push(Buffer.from(chunk)));

    runner.run('  test prompt  ', '/tmp', cb);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('codex');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'exec',
      '--json',
      '--full-auto',
      '--sandbox',
      'workspace-write',
      '--model',
      'gpt-5.3-codex-spark',
      '--ephemeral',
    ]);
    expect(Buffer.concat(stdinChunks).toString('utf8')).toBe('test prompt\n');

    proc.emit('close', 0, null);
    expect(cb.onDone).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('allows overriding optional codex flags through env vars', () => {
    vi.stubEnv('RTC_CODEX_EPHEMERAL', '0');
    vi.stubEnv('RTC_CODEX_SKIP_GIT_REPO_CHECK', '1');
    vi.stubEnv('RTC_CODEX_MODEL', 'gpt-5.3-codex');
    vi.stubEnv('RTC_CODEX_FULL_AUTO', '0');
    vi.stubEnv('RTC_CODEX_SANDBOX_MODE', 'read-only');

    const proc = queueProcess();
    const runner = new CodexRunner();
    const cb = callbacks();

    runner.run('patch this', '/tmp', cb);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-5.3-codex',
      '--skip-git-repo-check',
    ]);

    proc.emit('close', 0, null);
    expect(cb.onDone).toHaveBeenCalledTimes(1);
    expect(cb.onError).not.toHaveBeenCalled();
  });

  it('returns an error instead of spawning when instruction is empty', () => {
    const runner = new CodexRunner();
    const cb = callbacks();

    runner.run('   ', '/tmp', cb);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('reports an error when codex exits non-zero', () => {
    const proc = queueProcess();
    const runner = new CodexRunner();
    const cb = callbacks();

    runner.run('test', '/tmp', cb);
    proc.emit('close', 1, null);

    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(cb.onDone).not.toHaveBeenCalled();
  });

  it('rejects overlapping runs instead of cancelling the active one', () => {
    const first = queueProcess();

    const runner = new CodexRunner();
    const firstCb = callbacks();
    const secondCb = callbacks();

    runner.run('first', '/tmp', firstCb);
    runner.run('second', '/tmp', secondCb);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(secondCb.onError).toHaveBeenCalledTimes(1);
    expect(secondCb.onDone).not.toHaveBeenCalled();

    first.emit('close', 0, null);
    expect(firstCb.onDone).toHaveBeenCalledTimes(1);
    expect(firstCb.onError).not.toHaveBeenCalled();
  });
});
