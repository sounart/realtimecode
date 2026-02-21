import { spawn, type ChildProcess } from 'node:child_process';
import type { StreamEvent, UtteranceMetadata } from '@realtimecode/protocol';
import { logger } from '@realtimecode/shared';

export type SparkEventHandler = (event: StreamEvent) => void;

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SparkBridge {
  private workdir: string | null = null;
  private activeProcess: ChildProcess | null = null;
  private activeInstructionId: string | null = null;
  private handlers: SparkEventHandler[] = [];
  private sessionActive = false;

  onEvent(handler: SparkEventHandler): void {
    this.handlers.push(handler);
  }

  private broadcast(event: StreamEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  startSession(workdir: string): void {
    this.workdir = workdir;
    this.sessionActive = true;
    logger.info({ workdir }, 'spark session started');
  }

  submitInstruction(text: string, metadata: UtteranceMetadata): string {
    if (!this.sessionActive || !this.workdir) {
      throw new Error('No active Spark session');
    }

    const instructionId = `instr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.activeInstructionId = instructionId;

    if (process.env['SPARK_MOCK'] === '1') {
      void this.mockExecute(instructionId, text);
    } else {
      void this.spawnCodex(instructionId, text, metadata);
    }

    return instructionId;
  }

  cancelInstruction(id: string): boolean {
    if (this.activeInstructionId !== id) {
      return false;
    }

    if (this.activeProcess) {
      this.activeProcess.kill('SIGINT');
      this.activeProcess = null;
    }

    this.activeInstructionId = null;
    logger.info({ instructionId: id }, 'instruction cancelled');
    return true;
  }

  stopSession(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }

    this.activeInstructionId = null;
    this.sessionActive = false;
    this.workdir = null;
    logger.info('spark session stopped');
  }

  get isExecuting(): boolean {
    return this.activeInstructionId !== null;
  }

  private async mockExecute(instructionId: string, text: string): Promise<void> {
    this.broadcast({
      type: 'stdout',
      instructionId,
      chunk: `[spark] Received: ${text}\n`,
      timestamp: now()
    });

    await sleep(50);

    if (this.activeInstructionId !== instructionId) {
      return;
    }

    this.broadcast({
      type: 'tool_call',
      instructionId,
      toolName: 'file_edit',
      args: { description: text },
      timestamp: now()
    });

    await sleep(100);

    if (this.activeInstructionId !== instructionId) {
      return;
    }

    this.broadcast({
      type: 'file_change',
      instructionId,
      path: 'mock-file.ts',
      changeType: 'update',
      timestamp: now()
    });

    this.broadcast({
      type: 'stdout',
      instructionId,
      chunk: '[spark] Done.\n',
      timestamp: now()
    });

    this.activeInstructionId = null;
  }

  private async spawnCodex(
    instructionId: string,
    text: string,
    metadata: UtteranceMetadata
  ): Promise<void> {
    const cmd = process.env['SPARK_COMMAND'] ?? 'codex';
    const proc = spawn(cmd, ['exec', '--json'], {
      cwd: this.workdir ?? undefined,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.activeProcess = proc;

    const timeout = setTimeout(() => {
      if (this.activeInstructionId !== instructionId || this.activeProcess !== proc) {
        return;
      }

      logger.error({ instructionId }, 'instruction execution timed out');
      proc.kill('SIGTERM');
      this.broadcast({
        type: 'error',
        message: 'Instruction execution timed out after 30s',
        code: 'SPARK_TIMEOUT',
        recoverable: true,
        timestamp: now()
      });
      this.activeProcess = null;
      this.activeInstructionId = null;
    }, 30_000);

    proc.stdin?.write(JSON.stringify({ instruction: text, metadata }) + '\n');
    proc.stdin?.end();

    let buffer = '';

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk;

      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (line.length > 0) {
          this.handleSparkLine(instructionId, line);
        }

        nl = buffer.indexOf('\n');
      }
    });

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      this.broadcast({
        type: 'stdout',
        instructionId,
        chunk,
        timestamp: now()
      });
    });

    proc.on('error', (error) => {
      logger.error({ error, instructionId }, 'spark process error');
      this.broadcast({
        type: 'error',
        message: `Spark process error: ${error.message}`,
        code: 'SPARK_PROCESS_ERROR',
        recoverable: true,
        timestamp: now()
      });
      this.activeProcess = null;
      this.activeInstructionId = null;
    });

    await new Promise<void>((resolve) => {
      proc.on('close', () => {
        clearTimeout(timeout);

        if (this.activeProcess === proc) {
          this.activeProcess = null;
        }

        if (this.activeInstructionId === instructionId) {
          this.activeInstructionId = null;
        }

        resolve();
      });
    });
  }

  private handleSparkLine(instructionId: string, line: string): void {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;

      if (parsed['type'] === 'tool_call') {
        this.broadcast({
          type: 'tool_call',
          instructionId,
          toolName: String(parsed['tool'] ?? ''),
          args: (parsed['args'] as Record<string, unknown>) ?? {},
          timestamp: now()
        });
      } else if (parsed['type'] === 'file_change') {
        this.broadcast({
          type: 'file_change',
          instructionId,
          path: String(parsed['path'] ?? ''),
          changeType:
            (parsed['change'] as 'create' | 'update' | 'delete') ?? 'update',
          timestamp: now()
        });
      } else {
        this.broadcast({
          type: 'stdout',
          instructionId,
          chunk: line + '\n',
          timestamp: now()
        });
      }
    } catch {
      this.broadcast({
        type: 'stdout',
        instructionId,
        chunk: line + '\n',
        timestamp: now()
      });
    }
  }
}
