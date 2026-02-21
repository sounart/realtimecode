import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  InstructionCancelRequest,
  InstructionSubmitRequest,
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionStartRequest,
  SessionStopRequest,
  StreamEvent
} from '@realtimecode/protocol';
import { config, logger } from '@realtimecode/shared';
import { SessionManager } from './session-manager.js';

const session = new SessionManager();
const connectedSockets = new Set<net.Socket>();
let shuttingDown = false;
let activeServer: net.Server | null = null;

session.onEvent((event: StreamEvent) => {
  const method = `event.${event.type}`;

  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params: event
  });

  for (const socket of connectedSockets) {
    socket.write(notification + '\n');
  }
});

function okResponse(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  return { jsonrpc: '2.0', id, error };
}

function parseRequest(line: string): JsonRpcRequest | null {
  try {
    const parsed = JSON.parse(line) as JsonRpcRequest;

    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function handleRequest(request: JsonRpcRequest): JsonRpcResponse | null {
  const responseId = request.id ?? null;

  switch (request.method) {
    case 'session.start': {
      try {
        const params = request.params as SessionStartRequest;
        const result = session.startSession(params.workdir, params.profile);
        return okResponse(responseId, result);
      } catch (error) {
        return errorResponse(
          responseId,
          -32000,
          error instanceof Error ? error.message : 'Failed to start session'
        );
      }
    }
    case 'session.status': {
      const status = session.getStatus();
      return okResponse(responseId, status);
    }
    case 'instruction.submit': {
      try {
        const params = request.params as InstructionSubmitRequest;
        const result = session.submitText(params.text, params.metadata);
        return okResponse(responseId, result);
      } catch (error) {
        return errorResponse(
          responseId,
          -32000,
          error instanceof Error ? error.message : 'Failed to submit instruction'
        );
      }
    }
    case 'instruction.cancel': {
      const params = request.params as InstructionCancelRequest;
      const cancelled = session.cancelInstruction(params.instructionId);
      return okResponse(responseId, { cancelled });
    }
    case 'session.stop': {
      const params = request.params as SessionStopRequest;
      session.stopSession();
      return okResponse(responseId, { stopped: true, sessionId: params.sessionId });
    }
    case 'audio.stream': {
      const params = (request.params ?? {}) as { audio?: string };
      if (typeof params.audio === 'string' && params.audio.length > 0) {
        session.appendAudio(params.audio);
      }
      return request.id === undefined ? null : okResponse(responseId, { accepted: true });
    }
    case 'audio.commit': {
      session.commitHotkey();
      return request.id === undefined ? null : okResponse(responseId, { committed: true });
    }
    default:
      return errorResponse(responseId, -32601, `Unknown method: ${String(request.method)}`);
  }
}

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  session.stopSession();

  for (const socket of connectedSockets) {
    socket.end();
  }

  await new Promise<void>((resolve) => {
    if (!activeServer) {
      resolve();
      return;
    }

    activeServer.close(() => resolve());
  });

  await removeStaleSocket(config.socketPath);
  logger.info('orchestrator stopped');
  process.exit(code);
}

async function removeStaleSocket(pathname: string): Promise<void> {
  try {
    await fs.unlink(pathname);
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno !== 'ENOENT') {
      throw error;
    }
  }
}

async function startServer(): Promise<void> {
  await fs.mkdir(path.dirname(config.socketPath), { recursive: true });
  await removeStaleSocket(config.socketPath);

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    connectedSockets.add(socket);

    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);

        if (line.length > 0) {
          const request = parseRequest(line);
          const response = request
            ? handleRequest(request)
            : errorResponse(null, -32700, 'Parse error');

          if (response) {
            socket.write(`${JSON.stringify(response)}\n`);
          }
        }

        newline = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      connectedSockets.delete(socket);
    });

    socket.on('error', (error) => {
      connectedSockets.delete(socket);
      logger.warn({ error }, 'socket error');
    });
  });

  activeServer = server;

  server.listen(config.socketPath, () => {
    logger.info({ socketPath: config.socketPath }, 'orchestrator listening');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(0);
    });
  }

  process.on('uncaughtException', (error) => {
    logger.error({ error }, 'uncaught exception in orchestrator');
    void shutdown(1);
  });

  process.on('unhandledRejection', (error) => {
    logger.error({ error }, 'unhandled rejection in orchestrator');
    void shutdown(1);
  });
}

await startServer();
