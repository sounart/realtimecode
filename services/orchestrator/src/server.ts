import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionState, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';
import { Transcriber } from './transcriber.js';
import { CodexRunner } from './codex.js';

const SOCKET_PATH = process.env['RTC_SOCKET_PATH']
  ?? path.join(os.homedir(), '.runtime', 'realtimecode', 'orchestrator.sock');

let state: SessionState = 'idle';
let workdir: string | null = null;
let transcriber: Transcriber | null = null;
const codex = new CodexRunner();
const connectedSockets = new Set<net.Socket>();
let activeServer: net.Server | null = null;
let shuttingDown = false;

// --- Broadcast helpers ---

function notify(method: string, params: Record<string, unknown>): void {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
  const line = JSON.stringify(msg) + '\n';
  for (const s of connectedSockets) s.write(line);
}

function broadcastStatus(): void {
  notify('status', { state });
}

function broadcastError(message: string): void {
  notify('error', { message });
}

// --- State transitions ---

function setState(next: SessionState): void {
  state = next;
  broadcastStatus();
}

function startListening(dir: string): void {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    broadcastError('OPENAI_API_KEY not set');
    return;
  }

  workdir = dir;

  transcriber = new Transcriber({ apiKey }, {
    onPartialTranscript(text) {
      notify('transcript', { text, final: false });
    },
    onFinalTranscript(text) {
      notify('transcript', { text, final: true });
      executeInstruction(text);
    },
    onError(err) {
      console.error('Transcriber error:', err.message);
      broadcastError(err.message);
    },
    onReady() {
      console.log('Transcriber connected');
    },
  });

  transcriber.connect();
  setState('listening');
}

function executeInstruction(text: string): void {
  if (!workdir) return;

  setState('executing');

  codex.run(text, workdir, {
    onToolCall(tool, args) {
      notify('codex', { type: 'tool_call', data: { tool, args } });
    },
    onFileChange(filePath, changeType) {
      notify('codex', { type: 'file_change', data: { path: filePath, changeType } });
    },
    onOutput(output) {
      notify('codex', { type: 'output', data: { text: output } });
    },
    onDone() {
      if (state === 'executing') {
        setState('listening');
      }
    },
    onError(err) {
      console.error('Codex error:', err.message);
      broadcastError(err.message);
      if (state === 'executing') {
        setState('listening');
      }
    },
  });
}

function stopAll(): void {
  codex.cancel();
  if (transcriber) {
    transcriber.disconnect();
    transcriber = null;
  }
  workdir = null;
  setState('idle');
}

// --- RPC handling ---

function handleRequest(req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id ?? null;

  switch (req.method) {
    case 'start': {
      const params = req.params as { workdir?: string } | undefined;
      const dir = params?.workdir;
      if (typeof dir !== 'string' || !dir) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing workdir param' } };
      }
      if (state !== 'idle') stopAll();
      startListening(dir);
      return { jsonrpc: '2.0', id, result: { ok: true } };
    }
    case 'stop': {
      stopAll();
      return { jsonrpc: '2.0', id, result: { ok: true } };
    }
    case 'audio': {
      const params = req.params as { chunk?: string } | undefined;
      if (typeof params?.chunk === 'string' && params.chunk && transcriber) {
        transcriber.sendAudio(params.chunk);
      }
      // Notification — only respond if id present
      return id != null ? { jsonrpc: '2.0', id, result: { ok: true } } : null;
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${req.method}` } };
  }
}

function parseRequest(line: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest;
    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// --- Server lifecycle ---

async function removeStaleSocket(sockPath: string): Promise<void> {
  try {
    await fs.unlink(sockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  stopAll();
  for (const s of connectedSockets) s.end();

  await new Promise<void>((resolve) => {
    if (!activeServer) { resolve(); return; }
    activeServer.close(() => resolve());
  });

  await removeStaleSocket(SOCKET_PATH);
  console.log('Orchestrator stopped');
  process.exit(code);
}

async function startServer(): Promise<void> {
  await fs.mkdir(path.dirname(SOCKET_PATH), { recursive: true });
  await removeStaleSocket(SOCKET_PATH);

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    connectedSockets.add(socket);

    // Send current state on connect
    const status: JsonRpcNotification = { jsonrpc: '2.0', method: 'status', params: { state } };
    socket.write(JSON.stringify(status) + '\n');

    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (line) {
          const req = parseRequest(line);
          let response: JsonRpcResponse | null;

          try {
            response = req
              ? handleRequest(req)
              : { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
          } catch (err) {
            console.error('Request handler error:', err);
            response = { jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: 'Internal error' } };
          }

          if (response) socket.write(JSON.stringify(response) + '\n');
        }

        nl = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => connectedSockets.delete(socket));
    socket.on('error', (err) => {
      connectedSockets.delete(socket);
      console.error('Socket error:', err.message);
    });
  });

  activeServer = server;

  server.listen(SOCKET_PATH, () => {
    console.log(`Orchestrator listening on ${SOCKET_PATH}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(0));
  }
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    void shutdown(1);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    void shutdown(1);
  });
}

await startServer();
