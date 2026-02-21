import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type InstructionSubmitRequest,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SessionStartRequest,
  type SessionStopRequest
} from '@realtimecode/protocol';
import { config, logger } from '@realtimecode/shared';

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

function handleRequest(request: JsonRpcRequest): JsonRpcResponse {
  switch (request.method) {
    case 'session.start': {
      const params = request.params as SessionStartRequest;
      return okResponse(request.id, {
        sessionId: `session-${Date.now()}`,
        workdir: params.workdir,
        profile: params.profile,
        acceptedAt: new Date().toISOString()
      });
    }
    case 'instruction.submit': {
      const params = request.params as InstructionSubmitRequest;
      return okResponse(request.id, {
        instructionId: `instruction-${Date.now()}`,
        receivedText: params.text,
        queued: true
      });
    }
    case 'instruction.cancel': {
      return okResponse(request.id, { cancelled: true });
    }
    case 'session.stop': {
      const params = request.params as SessionStopRequest;
      return okResponse(request.id, { stopped: true, sessionId: params.sessionId });
    }
    default:
      return errorResponse(request.id, -32601, `Unknown method: ${request.method}`);
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

          socket.write(`${JSON.stringify(response)}\n`);
        }

        newline = buffer.indexOf('\n');
      }
    });

    socket.on('error', (error) => {
      logger.warn({ error }, 'socket error');
    });
  });

  server.listen(config.socketPath, () => {
    logger.info({ socketPath: config.socketPath }, 'orchestrator listening');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => {
        logger.info('orchestrator stopped');
        void removeStaleSocket(config.socketPath).finally(() => process.exit(0));
      });
    });
  }
}

await startServer();
