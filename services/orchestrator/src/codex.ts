import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from './logger.js';
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_SANDBOX_MODE,
  CODEX_TIMEOUT_MS,
  CODEX_KILL_GRACE_MS,
} from './config.js';

export interface CodexCallbacks {
  onToolCall: (tool: string, args: Record<string, unknown>) => void;
  onFileChange: (path: string, changeType: string) => void;
  onAssistantMessage: (text: string) => void;
  onOutput: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

interface SpawnContext {
  proc: ChildProcess;
  timeout: NodeJS.Timeout;
  forceKillTimer: NodeJS.Timeout | null;
  cancelled: boolean;
  latestAssistantMessage: string | null;
  cb: CodexCallbacks;
  runId: number;
  startedAtMs: number;
}

function parseEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class CodexRunner {
  private active: SpawnContext | null = null;
  private nextRunId = 1;
  private readonly killGraceMs = CODEX_KILL_GRACE_MS;

  cancel(): void {
    const active = this.active;
    if (!active) return;

    active.cancelled = true;
    if (active.latestAssistantMessage) {
      active.cb.onAssistantMessage(active.latestAssistantMessage);
    }
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
    const trimmedInstruction = instruction.trim();
    if (!trimmedInstruction) {
      cb.onError(new Error('Empty instruction ignored'));
      return;
    }
    if (this.active) {
      cb.onError(new Error('Codex execution already in progress'));
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
    const args = ['--ask-for-approval', 'never', 'exec', '--json'];
    const model = process.env['RTC_CODEX_MODEL']?.trim() || DEFAULT_CODEX_MODEL;
    const sandboxMode = process.env['RTC_CODEX_SANDBOX_MODE']?.trim() || DEFAULT_CODEX_SANDBOX_MODE;
    const dangerouslyBypassApprovalsAndSandbox = process.env['RTC_CODEX_DANGEROUSLY_BYPASS_SANDBOX'] !== '0';
    const fullAutoRequested = parseEnabled(process.env['RTC_CODEX_FULL_AUTO']);

    if (dangerouslyBypassApprovalsAndSandbox) {
      if (fullAutoRequested) {
        logger.warn('ignoring RTC_CODEX_FULL_AUTO because dangerous sandbox bypass is enabled');
      }
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      const fullAuto = fullAutoRequested && sandboxMode === 'workspace-write';
      if (fullAutoRequested && !fullAuto) {
        logger.warn('ignoring RTC_CODEX_FULL_AUTO because sandbox mode is not workspace-write', {
          sandboxMode,
        });
      }

      if (fullAuto) {
        args.push('--full-auto');
      }
      args.push('--sandbox', sandboxMode);
    }
    args.push('--model', model);

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

    const timeoutMs = CODEX_TIMEOUT_MS;
    const ctx: SpawnContext = {
      proc,
      timeout: setTimeout(() => {
        if (this.active !== ctx || ctx.cancelled) return;
        if (proc.exitCode !== null || proc.signalCode !== null) return;
        ctx.cancelled = true;
        this.active = null;

        const message = `Codex execution timed out after ${timeoutMs}ms`;
        logger.error('codex run timeout', { runId: ctx.runId, pid: proc.pid ?? null, timeoutMs });
        if (ctx.latestAssistantMessage) {
          ctx.cb.onAssistantMessage(ctx.latestAssistantMessage);
        }
        ctx.cb.onError(new Error(message));
        proc.kill('SIGTERM');
        this.scheduleForceKill(ctx, 'timeout');
      }, timeoutMs),
      forceKillTimer: null,
      cancelled: false,
      latestAssistantMessage: null,
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
        if (line) this.handleLine(line, ctx);
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
      if (trailing) this.handleLine(trailing, ctx);

      const elapsedMs = Date.now() - ctx.startedAtMs;
      logger.info('codex run exited', {
        runId: ctx.runId,
        pid: proc.pid ?? null,
        code,
        signal,
        elapsedMs,
      });

      if (ctx.latestAssistantMessage) {
        ctx.cb.onAssistantMessage(ctx.latestAssistantMessage);
      } else {
        logger.info('codex run exited without assistant summary', {
          runId: ctx.runId,
          code,
          signal,
        });
      }
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

  private handleLine(line: string, ctx: SpawnContext): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      this.captureAssistantMessage(parsed, ctx);

      if (parsed['type'] === 'tool_call') {
        ctx.cb.onToolCall(
          String(parsed['tool'] ?? ''),
          (parsed['args'] as Record<string, unknown>) ?? {},
        );
      } else if (parsed['type'] === 'file_change') {
        ctx.cb.onFileChange(
          String(parsed['path'] ?? ''),
          String(parsed['change'] ?? 'update'),
        );
      } else {
        ctx.cb.onOutput(line + '\n');
      }
    } catch {
      ctx.cb.onOutput(line + '\n');
    }
  }

  private captureAssistantMessage(parsed: Record<string, unknown>, ctx: SpawnContext): void {
    const direct = this.extractAssistantMessageText(parsed);
    if (direct) {
      ctx.latestAssistantMessage = direct;
      return;
    }

    const item = parsed['item'];
    const nested = this.extractAssistantMessageText(item);
    if (nested) {
      ctx.latestAssistantMessage = nested;
    }
  }

  private extractAssistantMessageText(value: unknown): string | null {
    if (!isRecord(value)) return null;

    const type = typeof value['type'] === 'string' ? value['type'] : '';
    const role = typeof value['role'] === 'string' ? value['role'] : '';
    const looksLikeAssistantMessage = (
      type === 'agent_message'
      || type === 'assistant_message'
      || type === 'message'
      || role === 'assistant'
    );
    if (!looksLikeAssistantMessage) return null;

    const directText = this.normalizeAssistantMessageText(
      typeof value['text'] === 'string' ? value['text'] : '',
    );
    if (directText) return directText;

    const contentText = this.extractTextFromUnknown(value['content']);
    if (contentText) return contentText;

    const outputText = this.extractTextFromUnknown(value['output']);
    if (outputText) return outputText;

    const nestedMessage = this.extractAssistantMessageText(value['message']);
    if (nestedMessage) return nestedMessage;

    return null;
  }

  private extractTextFromUnknown(value: unknown): string | null {
    if (typeof value === 'string') {
      return this.normalizeAssistantMessageText(value);
    }
    if (!Array.isArray(value)) return null;

    const collected: string[] = [];
    for (const part of value) {
      if (typeof part === 'string') {
        collected.push(part);
        continue;
      }
      if (!isRecord(part)) continue;

      if (typeof part['text'] === 'string') {
        collected.push(part['text']);
      }
      const nested = this.extractTextFromUnknown(part['content']);
      if (nested) {
        collected.push(nested);
      }
    }

    return this.normalizeAssistantMessageText(collected.join(' '));
  }

  private normalizeAssistantMessageText(raw: string): string | null {
    const normalized = raw.replace(/\s+/g, ' ').trim();
    return normalized || null;
  }
}
