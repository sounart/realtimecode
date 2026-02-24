import { spawn, type ChildProcess } from 'node:child_process';

export interface CodexCallbacks {
  onToolCall: (tool: string, args: Record<string, unknown>) => void;
  onFileChange: (path: string, changeType: string) => void;
  onOutput: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export class CodexRunner {
  private process: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private hasRunBefore = false;

  cancel(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  run(instruction: string, workdir: string, cb: CodexCallbacks): void {
    this.cancel();

    const cmd = process.env['CODEX_COMMAND'] ?? 'codex';
    const useResume = this.hasRunBefore;
    const args = useResume
      ? ['exec', 'resume', '--last', '--full-auto', '--json']
      : ['exec', '--full-auto', '--json'];

    this.spawn(cmd, args, instruction, workdir, cb, useResume);
  }

  private spawn(
    cmd: string,
    args: string[],
    instruction: string,
    workdir: string,
    cb: CodexCallbacks,
    isResume: boolean,
  ): void {
    const proc = spawn(cmd, args, {
      cwd: workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = proc;

    this.timeout = setTimeout(() => {
      if (this.process === proc) {
        console.error('Codex execution timed out after 120s');
        proc.kill('SIGTERM');
        cb.onError(new Error('Codex execution timed out after 120s'));
        this.process = null;
        this.timeout = null;
      }
    }, 120_000);

    proc.stdin?.write(instruction + '\n');
    proc.stdin?.end();

    let buffer = '';

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line) this.handleLine(line, cb);
        nl = buffer.indexOf('\n');
      }
    });

    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => cb.onOutput(chunk));

    proc.on('error', (error) => {
      this.cleanup(proc);
      if (isResume && error.message.includes('ENOENT')) {
        // resume failed — retry as fresh exec
        this.spawn(cmd, ['exec', '--full-auto', '--json'], instruction, workdir, cb, false);
        return;
      }
      if (error.message.includes('ENOENT')) {
        cb.onError(new Error('codex CLI not found — install it with: npm i -g @openai/codex'));
      } else {
        cb.onError(error);
      }
    });

    proc.on('close', (code) => {
      const trailing = buffer.replace(/\r$/, '').trim();
      if (trailing) this.handleLine(trailing, cb);
      this.cleanup(proc);
      this.hasRunBefore = true;

      if (code !== 0 && isResume) {
        // resume --last failed at runtime — retry as fresh exec
        console.log('Codex resume failed, retrying as fresh exec');
        this.spawn(cmd, ['exec', '--full-auto', '--json'], instruction, workdir, cb, false);
        return;
      }

      cb.onDone();
    });
  }

  private cleanup(proc: ChildProcess): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.process === proc) {
      this.process = null;
    }
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
