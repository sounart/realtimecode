import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from './logger.js';

export interface CodexCallbacks {
  onToolCall: (tool: string, args: Record<string, unknown>) => void;
  onFileChange: (path: string, changeType: string) => void;
  onOutput: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

interface SpawnContext {
  proc: ChildProcess;
  timeout: NodeJS.Timeout;
  forceKillTimer: NodeJS.Timeout | null;
  cancelled: boolean;
  cb: CodexCallbacks;
  runId: number;
  startedAtMs: number;
}

function parseTimeoutMs(raw: string | undefined): number {
  const fallback = 120_000;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 10_000) return fallback;
  return Math.floor(parsed);
}

function parseKillGraceMs(raw: string | undefined): number {
  const fallback = 1_500;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 100) return fallback;
  return Math.floor(parsed);
}

export class CodexRunner {
  private active: SpawnContext | null = null;
  private nextRunId = 1;
  private readonly killGraceMs = parseKillGraceMs(process.env['RTC_CODEX_KILL_GRACE_MS']);

  cancel(): void {
    const active = this.active;
    if (!active) return;

    active.cancelled = true;
    clearTimeout(active.timeout);
    if (active.forceKillTimer) {
      clearTimeout(active.forceKillTimer);
      active.forceKillTimer = null;
    }
    this.active = null;

    if (!active.proc.killed) {
      active.proc.kill('SIGTERM');
      this.scheduleForceKill(active, 'cancel');
    }

    logger.info('codex run cancelled', { runId: active.runId, pid: active.proc.pid ?? null });
  }

  get isRunning(): boolean {
    return this.active !== null;
  }

  run(instruction: string, workdir: string, cb: CodexCallbacks): void {
    this.cancel();

    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) {
      cb.onError(new Error('Empty instruction ignored'));
      return;
    }

    const cmd = process.env['CODEX_COMMAND'] ?? 'codex';
    const runId = this.nextRunId++;
    const args = this.buildArgs();

    this.spawn({
      runId,
      cmd,
      args,
      instruction: trimmedInstruction,
      workdir,
      cb,
    });
  }

  private buildArgs(): string[] {
    const args = ['exec', '--full-auto', '--json'];

    if (process.env['RTC_CODEX_EPHEMERAL'] !== '0') {
      args.push('--ephemeral');
    }
    if (process.env['RTC_CODEX_SKIP_GIT_REPO_CHECK'] === '1') {
      args.push('--skip-git-repo-check');
    }

    return args;
  }

  private spawn(params: {
    runId: number;
    cmd: string,
    args: string[];
    instruction: string;
    workdir: string;
    cb: CodexCallbacks;
  }): void {
    const proc = spawn(params.cmd, params.args, {
      cwd: params.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    logger.info('codex run started', {
      runId: params.runId,
      cmd: params.cmd,
      args: params.args,
      workdir: params.workdir,
      pid: proc.pid ?? null,
    });

    let buffer = '';

    const timeoutMs = parseTimeoutMs(process.env['RTC_CODEX_TIMEOUT_MS']);
    const ctx: SpawnContext = {
      proc,
      timeout: setTimeout(() => {
        if (this.active !== ctx || ctx.cancelled) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        ctx.cancelled = true;
        this.active = null;

        const message = `Codex execution timed out after ${timeoutMs}ms`;
        logger.error('codex run timeout', { runId: ctx.runId, pid: proc.pid ?? null, timeoutMs });
        ctx.cb.onError(new Error(message));
        proc.kill('SIGTERM');
        this.scheduleForceKill(ctx, 'timeout');
      }, timeoutMs),
      forceKillTimer: null,
      cancelled: false,
      cb: params.cb,
      runId: params.runId,
      startedAtMs: Date.now(),
    };
    this.active = ctx;

    proc.stdin?.on('error', (err) => {
      // Child may exit before stdin flushes; log and continue.
      logger.warn('codex stdin error', {
        runId: ctx.runId,
        pid: proc.pid ?? null,
        message: err.message,
      });
    });
    proc.stdin?.write(`${params.instruction}\n`);
    proc.stdin?.end();

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (this.active !== ctx || ctx.cancelled) return;
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line) this.handleLine(line, ctx.cb);
        nl = buffer.indexOf('\n');
      }
    });

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      if (this.active !== ctx || ctx.cancelled) return;
      ctx.cb.onOutput(chunk);
    });

    proc.on('error', (error) => {
      const wasActive = this.active === ctx;
      clearTimeout(ctx.timeout);
      if (ctx.forceKillTimer) {
        clearTimeout(ctx.forceKillTimer);
        ctx.forceKillTimer = null;
      }
      if (wasActive) {
        this.active = null;
      }
      if (!wasActive || ctx.cancelled) return;

      logger.error('codex process error', {
        runId: ctx.runId,
        pid: proc.pid ?? null,
        message: error.message,
      });

      if (error.message.includes('ENOENT')) {
        ctx.cb.onError(new Error('codex CLI not found — install it with: npm i -g @openai/codex'));
      } else {
        ctx.cb.onError(error);
      }
    });

    proc.on('close', (code, signal) => {
      const wasActive = this.active === ctx;
      clearTimeout(ctx.timeout);
      if (ctx.forceKillTimer) {
        clearTimeout(ctx.forceKillTimer);
        ctx.forceKillTimer = null;
      }
      if (wasActive) {
        this.active = null;
      }
      if (!wasActive || ctx.cancelled) return;

      const trailing = buffer.replace(/\r$/, '').trim();
      if (trailing) this.handleLine(trailing, ctx.cb);

      const elapsedMs = Date.now() - ctx.startedAtMs;
      logger.info('codex run exited', {
        runId: ctx.runId,
        pid: proc.pid ?? null,
        code,
        signal,
        elapsedMs,
      });

      if (signal !== null || code !== 0) {
        const reason = signal !== null
          ? `Codex exited due to signal ${signal}`
          : `Codex exited with code ${String(code)}`;
        ctx.cb.onError(new Error(reason));
        return;
      }

      ctx.cb.onDone();
    });
  }

  private scheduleForceKill(ctx: SpawnContext, reason: 'cancel' | 'timeout'): void {
    if (ctx.forceKillTimer) return;
    ctx.forceKillTimer = setTimeout(() => {
      ctx.forceKillTimer = null;
      if (ctx.proc.exitCode !== null || ctx.proc.signalCode !== null) return;
      logger.warn('codex run still alive after SIGTERM; escalating to SIGKILL', {
        runId: ctx.runId,
        pid: ctx.proc.pid ?? null,
        reason,
        graceMs: this.killGraceMs,
      });
      ctx.proc.kill('SIGKILL');
    }, this.killGraceMs);
  }

  private handleLine(line: string, cb: CodexCallbacks): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      if (parsed['type'] === 'tool_call') {
        cb.onToolCall(
          String(parsed['tool'] ?? ''),
          (parsed['args'] as Record<string, unknown>) ?? {},
        );
      } else if (parsed['type'] === 'file_change') {
        cb.onFileChange(
          String(parsed['path'] ?? ''),
          String(parsed['change'] ?? 'update'),
        );
      } else {
        cb.onOutput(line + '\n');
      }
    } catch {
      cb.onOutput(line + '\n');
    }
  }
}
