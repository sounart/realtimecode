import { select, input } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import type { JsonRpcResponse, StreamEvent } from '@realtimecode/protocol';
import { config } from '@realtimecode/shared';

type DirectoryOption = {
  name: string;
  value: string;
};

async function discoverDirectories(baseDir: string): Promise<DirectoryOption[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      value: path.join(baseDir, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sendRpc(
  socket: net.Socket,
  method: string,
  params: unknown
): Promise<JsonRpcResponse> {
  const id = `rpc-${Date.now()}`;
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  return new Promise((resolve, reject) => {
    let buffer = '';

    const onData = (chunk: string): void => {
      buffer += chunk;

      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line) as JsonRpcResponse & { method?: string };

            if (parsed.id === id) {
              socket.off('data', onData);
              resolve(parsed);
              return;
            }
          } catch {
            // Skip non-JSON lines
          }
        }

        nl = buffer.indexOf('\n');
      }
    };

    socket.on('data', onData);
    socket.on('error', reject);
    socket.write(request + '\n');
  });
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(500);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.once('error', () => {
      resolve(false);
    });
  });
}

async function ensureOrchestratorRunning(): Promise<void> {
  if (await canConnect(config.socketPath)) {
    return;
  }

  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(thisFile), '../../../../');
  const daemon = spawn('npx', ['tsx', 'services/orchestrator/src/server.ts'], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore'
  });
  daemon.unref();

  const timeoutMs = 15000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fs.stat(config.socketPath);
      if (await canConnect(config.socketPath)) {
        return;
      }
    } catch {
      // Socket not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Failed to start orchestrator daemon within ${timeoutMs}ms`);
}

function formatEvent(event: StreamEvent): string {
  switch (event.type) {
    case 'status':
      return `[status] ${event.state}`;
    case 'transcript':
      return event.final ? `[transcript final] ${event.text}` : `[transcript] ${event.text}`;
    case 'stdout':
      return event.chunk.trimEnd();
    case 'tool_call':
      return `[tool] ${event.toolName}(${JSON.stringify(event.args)})`;
    case 'file_change':
      return `[file] ${event.changeType} ${event.path}`;
    case 'error':
      return `[error] ${event.message}`;
  }
}

function streamEvents(socket: net.Socket): void {
  let buffer = '';

  socket.on('data', (chunk: string) => {
    buffer += chunk;

    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as { method?: string; params?: StreamEvent };

          if (parsed.method && (parsed.method === 'event.stream' || parsed.method.startsWith('event.')) && parsed.params) {
            console.log(formatEvent(parsed.params));
          }
        } catch {
          // Skip non-JSON lines
        }
      }

      nl = buffer.indexOf('\n');
    }
  });
}

export async function runStart(): Promise<void> {
  const cwd = process.cwd();
  const dirs = await discoverDirectories(cwd);

  const selected = await select({
    message: 'Pick a working directory for RealtimeCode:',
    choices: [
      ...dirs.map((dir) => ({ name: dir.name, value: dir.value })),
      { name: 'Use current directory', value: cwd },
      { name: 'Enter a custom path', value: '__custom__' }
    ],
    pageSize: 12
  });

  const workdir =
    selected === '__custom__'
      ? await input({
          message: 'Enter an absolute directory path:',
          validate: async (value) => {
            if (!path.isAbsolute(value)) {
              return 'Path must be absolute.';
            }

            try {
              const stat = await fs.stat(value);
              return stat.isDirectory() ? true : 'Path is not a directory.';
            } catch {
              return 'Directory does not exist.';
            }
          }
        })
      : selected;

  console.log(`Connecting to orchestrator at ${config.socketPath}...`);
  await ensureOrchestratorRunning();

  const socket = net.createConnection(config.socketPath);
  socket.setEncoding('utf8');

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', (err) => {
      reject(new Error(`Failed to connect to orchestrator: ${err.message}`));
    });
  });

  console.log('Connected. Starting session...');

  const response = await sendRpc(socket, 'session.start', {
    workdir,
    profile: 'default'
  });

  if (response.error) {
    console.error(`Error: ${response.error.message}`);
    socket.destroy();
    return;
  }

  const result = response.result as { sessionId: string; workdir: string };
  console.log(`Session started: ${result.sessionId}`);
  console.log(`Working directory: ${result.workdir}`);
  console.log('Streaming events (Ctrl+C to stop)...\n');

  streamEvents(socket);

  const cleanup = (): void => {
    console.log('\nStopping session...');
    const stopReq = JSON.stringify({
      jsonrpc: '2.0',
      id: 'stop',
      method: 'session.stop',
      params: { sessionId: result.sessionId }
    });
    socket.write(stopReq + '\n');
    setTimeout(() => {
      socket.destroy();
      process.exit(0);
    }, 500);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  socket.on('close', () => {
    console.log('Disconnected from orchestrator.');
    process.exit(0);
  });
}
