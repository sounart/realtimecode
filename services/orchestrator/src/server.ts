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

session.onEvent((event: StreamEvent) => {
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: `event.${event.type}`,
    params: event
  });

  for (const socket of connectedSockets) {
    socket.write(notification + '\n');
  }
});

function okResponse(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
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

function handleNotification(request: JsonRpcRequest): void {
  switch (request.method) {
    case 'audio.stream': {
      const params = request.params as { audio: string };
      session.appendAudio(params.audio);
      break;
    }
    case 'audio.commit': {
      session.commitHotkey();
      break;
    }
    default:
      logger.warn({ method: request.method }, 'unknown notification method');
  }
}

function handleRequest(request: JsonRpcRequest): JsonRpcResponse {
  switch (request.method) {
    case 'session.start': {
      try {
        const params = request.params as SessionStartRequest;
        const result = session.startSession(params.workdir, params.profile);
        return okResponse(request.id, result);
      } catch (error) {
        return errorResponse(
          request.id,
          -32000,
          error instanceof Error ? error.message : 'Failed to start session'
        );
      }
    }
    case 'session.status': {
      const status = session.getStatus();
      return okResponse(request.id, status);
    }
    case 'instruction.submit': {
      try {
        const params = request.params as InstructionSubmitRequest;
        const result = session.submitText(params.text, params.metadata);
        return okResponse(request.id, result);
      } catch (error) {
        return errorResponse(
          request.id,
          -32000,
          error instanceof Error ? error.message : 'Failed to submit instruction'
        );
      }
    }
    case 'instruction.cancel': {
      const params = request.params as InstructionCancelRequest;
      const cancelled = session.cancelInstruction(params.instructionId);
      return okResponse(request.id, { cancelled });
    }
    case 'session.stop': {
      const params = request.params as SessionStopRequest;
      session.stopSession();
      return okResponse(request.id, { stopped: true, sessionId: params.sessionId });
    }
    default:
      return errorResponse(request.id, -32601, `Unknown method: ${String(request.method)}`);
  }
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

          if (request && request.id == null) {
            // JSON-RPC notification (no id) — handle without response
            handleNotification(request);
          } else {
            const response = request
              ? handleRequest(request)
              : errorResponse(null, -32700, 'Parse error');

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

  server.listen(config.socketPath, () => {
    logger.info({ socketPath: config.socketPath }, 'orchestrator listening');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      session.stopSession();
      server.close(() => {
        logger.info('orchestrator stopped');
        void removeStaleSocket(config.socketPath).finally(() => process.exit(0));
      });
    });
  }
}

await startServer();
