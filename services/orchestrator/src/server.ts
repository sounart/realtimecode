import net from 'node:net';
import { promises as fs } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionState, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types.js';
import { Transcriber } from './transcriber.js';
import { CodexRunner } from './codex.js';
import { validateWorkdir } from './workdir.js';
import { getLogPath, logger } from './logger.js';
import {
  SOCKET_PATH,
  SOCKET_DIR,
  AUTH_REQUIRED,
  AUTH_TOKEN_PATH,
  MAX_RPC_LINE_BYTES,
  MAX_AUDIO_CHUNK_BASE64_CHARS,
  LOG_INSTRUCTION_PREVIEW,
  TRANSCRIPT_COMMIT_DELAY_MS,
  MIN_EXECUTABLE_TRANSCRIPT_CHARS,
  MIN_EXECUTABLE_TRANSCRIPT_WORDS,
  MAX_PENDING_INSTRUCTIONS,
  TRANSCRIPT_DEDUPE_WINDOW_MS,
  CODEX_INSTRUCTION_PREFIX,
  FILLER_WORDS,
  SHORT_COMMAND_WORDS,
} from './config.js';

let state: SessionState = 'idle';
let workdir: string | null = null;
let transcriber: Transcriber | null = null;
const codex = new CodexRunner();
const connectedSockets = new Set<net.Socket>();
const authenticatedSockets = new Set<net.Socket>();
let activeServer: net.Server | null = null;
let shuttingDown = false;
let authToken: string | null = null;
const pendingInstructions: string[] = [];
let transcriptParts: string[] = [];
let transcriptCommitTimer: NodeJS.Timeout | null = null;
let partialTranscript = '';
let lastQueuedInstruction = '';
let lastQueuedAtMs = 0;

function isSocketAuthenticated(socket: net.Socket): boolean {
  return !AUTH_REQUIRED || authenticatedSockets.has(socket);
}

function sendNotification(
  socket: net.Socket,
  method: string,
  params: Record<string, unknown>,
): void {
  const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
  socket.write(JSON.stringify(msg) + '\n');
}

function sendStatus(socket: net.Socket): void {
  sendNotification(socket, 'status', { state });
}

// --- Broadcast helpers ---

function notify(method: string, params: Record<string, unknown>): void {
  for (const s of connectedSockets) {
    if (!isSocketAuthenticated(s)) continue;
    sendNotification(s, method, params);
  }
}

function broadcastStatus(): void {
  notify('status', { state });
}

function broadcastError(message: string): void {
  notify('error', { message });
}

// --- State transitions ---

function setState(next: SessionState): void {
  const prev = state;
  if (prev === next) return;

  state = next;
  logger.info('state changed', { from: prev, to: next });
  broadcastStatus();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function tokenizeWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? [])
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0);
}

function clearTranscriptParts(): void {
  transcriptParts = [];
  if (transcriptCommitTimer) {
    clearTimeout(transcriptCommitTimer);
    transcriptCommitTimer = null;
  }
}

function clearPartialTranscript(): void {
  partialTranscript = '';
}

function clearInstructionQueue(): void {
  pendingInstructions.length = 0;
  clearTranscriptParts();
  clearPartialTranscript();
  lastQueuedInstruction = '';
  lastQueuedAtMs = 0;
}

function appendPartialTranscriptDelta(delta: string): string {
  partialTranscript += delta;
  return normalizeText(partialTranscript);
}

function interruptExecutionForLiveSpeech(trigger: 'speech_started' | 'partial_transcript'): void {
  if (state !== 'executing' || !codex.isRunning) return;

  const droppedQueueDepth = pendingInstructions.length;
  logger.info('interrupting active codex run due to new speech', {
    trigger,
    droppedQueueDepth,
  });

  codex.cancel();
  clearInstructionQueue();
  if (droppedQueueDepth > 0) {
    notify('codex', { type: 'queued', data: { queueDepth: 0 } });
  }
  setState('listening');
}

function shouldIgnoreInstructionText(normalized: string): { ignore: boolean; reason?: string; words: number; alnumChars: number } {
  const words = tokenizeWords(normalized);
  const alnumChars = normalized.replace(/[^a-z0-9]/gi, '').length;

  if (!normalized) return { ignore: true, reason: 'empty', words: 0, alnumChars: 0 };
  if (words.length === 0) return { ignore: true, reason: 'no_words', words: 0, alnumChars };
  if (words.length === 1 && FILLER_WORDS.has(words[0] ?? '')) {
    return { ignore: true, reason: 'single_filler_word', words: 1, alnumChars };
  }
  if (words.length <= 3 && words.every((w) => FILLER_WORDS.has(w))) {
    return { ignore: true, reason: 'filler_words_only', words: words.length, alnumChars };
  }
  if (words.length === 1 && SHORT_COMMAND_WORDS.has(words[0] ?? '')) {
    return { ignore: false, words: 1, alnumChars };
  }
  if (alnumChars < MIN_EXECUTABLE_TRANSCRIPT_CHARS && words.length < MIN_EXECUTABLE_TRANSCRIPT_WORDS) {
    return { ignore: true, reason: 'too_short', words: words.length, alnumChars };
  }
  return { ignore: false, words: words.length, alnumChars };
}

function processInstructionQueue(options?: { allowWhileExecuting?: boolean }): boolean {
  if (!workdir) return false;
  if (codex.isRunning) return false;
  if (state === 'idle') return false;
  if (state === 'executing' && options?.allowWhileExecuting !== true) return false;

  const nextInstruction = pendingInstructions.shift();
  if (!nextInstruction) return false;

  executeInstruction(nextInstruction);
  return true;
}

function enqueueInstruction(text: string): void {
  const normalized = normalizeText(text);
  const decision = shouldIgnoreInstructionText(normalized);
  if (decision.ignore) {
    logger.info('ignoring final transcript', {
      reason: decision.reason ?? 'unknown',
      words: decision.words,
      alnumChars: decision.alnumChars,
      rawChars: text.length,
    });
    return;
  }

  const now = Date.now();
  if (normalized === lastQueuedInstruction && now - lastQueuedAtMs <= TRANSCRIPT_DEDUPE_WINDOW_MS) {
    logger.info('ignoring duplicate final transcript', {
      words: decision.words,
      alnumChars: decision.alnumChars,
      dedupeWindowMs: TRANSCRIPT_DEDUPE_WINDOW_MS,
    });
    return;
  }

  if (pendingInstructions.length >= MAX_PENDING_INSTRUCTIONS) {
    pendingInstructions.shift();
    logger.warn('instruction queue full; dropped oldest queued instruction', {
      maxPendingInstructions: MAX_PENDING_INSTRUCTIONS,
    });
  }

  pendingInstructions.push(normalized);
  lastQueuedInstruction = normalized;
  lastQueuedAtMs = now;
  logger.info('instruction queued', {
    chars: normalized.length,
    queueDepth: pendingInstructions.length,
  });
  notify('codex', { type: 'queued', data: { queueDepth: pendingInstructions.length } });
  processInstructionQueue();
}

function flushQueuedTranscriptParts(): void {
  if (transcriptParts.length === 0) return;
  const merged = normalizeText(transcriptParts.join(' '));
  transcriptParts = [];
  enqueueInstruction(merged);
}

function bufferFinalTranscript(text: string): void {
  const normalized = normalizeText(text);
  if (!normalized) return;

  transcriptParts.push(normalized);
  if (transcriptCommitTimer) clearTimeout(transcriptCommitTimer);
  transcriptCommitTimer = setTimeout(() => {
    transcriptCommitTimer = null;
    flushQueuedTranscriptParts();
  }, TRANSCRIPT_COMMIT_DELAY_MS);
}

function startListening(dir: string): string | null {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    logger.warn('start rejected: missing OPENAI_API_KEY');
    return 'OPENAI_API_KEY not set';
  }

  workdir = dir;
  clearInstructionQueue();

  if (transcriber) {
    transcriber.disconnect();
    transcriber = null;
  }

  transcriber = new Transcriber({ apiKey }, {
    onPartialTranscript(text) {
      const cumulative = appendPartialTranscriptDelta(text);
      if (cumulative) {
        notify('transcript', { text: cumulative, final: false });
      }
      if (/[a-z0-9]/i.test(text)) {
        interruptExecutionForLiveSpeech('partial_transcript');
      }
    },
    onFinalTranscript(text) {
      clearPartialTranscript();
      notify('transcript', { text, final: true });
      bufferFinalTranscript(text);
    },
    onSpeechStarted() {
      clearPartialTranscript();
      interruptExecutionForLiveSpeech('speech_started');
    },
    onError(err) {
      logger.error('transcriber error', { message: err.message });
      broadcastError(err.message);

      if (err.message.includes('reconnect attempts exhausted') && state === 'listening') {
        if (transcriber) {
          transcriber.disconnect();
          transcriber = null;
        }
        workdir = null;
        setState('idle');
      }
    },
    onReady() {
      logger.info('transcriber connected');
    },
  });

  transcriber.connect();
  setState('listening');
  return null;
}

function executeInstruction(text: string): void {
  if (!workdir) return;

  const normalized = normalizeText(text);
  const codexInstruction = `${CODEX_INSTRUCTION_PREFIX}\n\nUser request:\n${normalized}`;
  const meta: Record<string, unknown> = {
    chars: normalized.length,
    queueDepth: pendingInstructions.length,
  };
  if (LOG_INSTRUCTION_PREVIEW) {
    meta['preview'] = normalized.slice(0, 200);
  }
  logger.info('executing instruction', meta);

  setState('executing');

  codex.run(codexInstruction, workdir, {
    onToolCall(tool, args) {
      notify('codex', { type: 'tool_call', data: { tool, args } });
    },
    onFileChange(filePath, changeType) {
      notify('codex', { type: 'file_change', data: { path: filePath, changeType } });
    },
    onAssistantMessage(text) {
      notify('codex', { type: 'assistant_message', data: { text } });
    },
    onOutput(output) {
      process.stdout.write(output);
    },
    onDone() {
      notify('codex', { type: 'done', data: {} });
      logger.info('codex run completed');
      if (processInstructionQueue({ allowWhileExecuting: true })) return;
      if (state === 'executing') setState('listening');
    },
    onError(err) {
      logger.error('codex run failed', { message: err.message });
      broadcastError(err.message);
      if (processInstructionQueue({ allowWhileExecuting: true })) return;
      if (state === 'executing') setState('listening');
    },
  });
}

function stopAll(): void {
  logger.info('stop requested');
  codex.cancel();
  clearInstructionQueue();
  if (transcriber) {
    transcriber.disconnect();
    transcriber = null;
  }
  workdir = null;
  setState('idle');
}

// --- RPC handling ---

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

function handleRequest(req: JsonRpcRequest, socket: net.Socket): JsonRpcResponse | null {
  const id = req.id ?? null;

  if (AUTH_REQUIRED && !authenticatedSockets.has(socket)) {
    if (req.method !== 'auth') {
      return id != null
        ? { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized: call auth first' } }
        : null;
    }

    const params = req.params as { token?: string } | undefined;
    const presentedToken = params?.token;
    if (typeof presentedToken !== 'string' || !presentedToken || !authToken || !safeTokenEquals(presentedToken, authToken)) {
      logger.warn('socket auth rejected');
      return id != null
        ? { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized: invalid token' } }
        : null;
    }

    authenticatedSockets.add(socket);
    logger.info('socket authenticated');
    sendStatus(socket);
    return id != null ? { jsonrpc: '2.0', id, result: { ok: true } } : null;
  }

  switch (req.method) {
    case 'auth':
      return id != null ? { jsonrpc: '2.0', id, result: { ok: true } } : null;
    case 'start': {
      const params = req.params as { workdir?: string } | undefined;
      const dir = params?.workdir;
      if (typeof dir !== 'string' || !dir) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Missing workdir param' } };
      }

      const validation = validateWorkdir(dir);
      if (validation.error || !validation.resolvedWorkdir) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: validation.error ?? 'Invalid workdir' } };
      }

      if (state !== 'idle') stopAll();
      const startError = startListening(validation.resolvedWorkdir);
      if (startError) {
        broadcastError(startError);
        return { jsonrpc: '2.0', id, error: { code: -32000, message: startError } };
      }
      return { jsonrpc: '2.0', id, result: { ok: true } };
    }
    case 'stop': {
      stopAll();
      return { jsonrpc: '2.0', id, result: { ok: true } };
    }
    case 'audio': {
      const params = req.params as { chunk?: string } | undefined;
      if (typeof params?.chunk === 'string' && params.chunk) {
        if (params.chunk.length > MAX_AUDIO_CHUNK_BASE64_CHARS) {
          logger.warn('audio chunk rejected: too large', {
            chars: params.chunk.length,
            maxChars: MAX_AUDIO_CHUNK_BASE64_CHARS,
          });
          const errMessage = 'Audio chunk too large';
          broadcastError(errMessage);
          return id != null
            ? { jsonrpc: '2.0', id, error: { code: -32602, message: errMessage } }
            : null;
        }

        if (transcriber) {
          transcriber.sendAudio(params.chunk);
        }
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
    const stats = await fs.lstat(sockPath);
    if (!stats.isSocket()) return;
    await fs.unlink(sockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function readAuthTokenFromDisk(tokenPath: string): Promise<string | null> {
  try {
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (token.length >= 16) return token;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function persistAuthTokenToDisk(token: string): Promise<void> {
  await fs.mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SOCKET_DIR, 0o700).catch(() => {
    logger.warn('failed to enforce socket directory permissions', { socketDir: SOCKET_DIR });
  });
  await fs.writeFile(AUTH_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  await fs.chmod(AUTH_TOKEN_PATH, 0o600).catch(() => {
    logger.warn('failed to enforce auth token file permissions', { authTokenPath: AUTH_TOKEN_PATH });
  });
}

async function resolveAuthToken(): Promise<string | null> {
  if (!AUTH_REQUIRED) return null;

  const envToken = process.env['RTC_AUTH_TOKEN']?.trim();
  if (envToken && envToken.length >= 16) {
    await persistAuthTokenToDisk(envToken);
    return envToken;
  }

  await fs.mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SOCKET_DIR, 0o700).catch(() => {
    logger.warn('failed to enforce socket directory permissions', { socketDir: SOCKET_DIR });
  });

  const existing = await readAuthTokenFromDisk(AUTH_TOKEN_PATH);
  if (existing) return existing;

  const generated = randomBytes(32).toString('hex');
  try {
    await fs.writeFile(AUTH_TOKEN_PATH, `${generated}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = await readAuthTokenFromDisk(AUTH_TOKEN_PATH);
      if (raced) return raced;
      await fs.writeFile(AUTH_TOKEN_PATH, `${generated}\n`, { mode: 0o600 });
    } else {
      throw err;
    }
  }
  await fs.chmod(AUTH_TOKEN_PATH, 0o600).catch(() => {
    logger.warn('failed to enforce auth token file permissions', { authTokenPath: AUTH_TOKEN_PATH });
  });

  return generated;
}

async function ensureSocketPathAvailable(sockPath: string): Promise<void> {
  try {
    const stats = await fs.lstat(sockPath);
    if (!stats.isSocket()) {
      throw new Error(`Socket path exists but is not a socket: ${sockPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const probeResult = await new Promise<'active' | 'stale'>((resolve, reject) => {
    const probe = net.createConnection(sockPath);
    const cleanup = () => {
      probe.removeAllListeners();
      probe.setTimeout(0);
    };

    probe.once('connect', () => {
      cleanup();
      probe.end();
      resolve('active');
    });

    probe.once('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      probe.destroy();
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        resolve('stale');
      } else {
        reject(err);
      }
    });

    probe.setTimeout(300, () => {
      cleanup();
      probe.destroy();
      resolve('stale');
    });
  });

  if (probeResult === 'active') {
    throw new Error(`Socket already in use: ${sockPath}`);
  }

  await removeStaleSocket(sockPath);
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
  logger.info('orchestrator stopped');
  process.exit(code);
}

async function startServer(): Promise<void> {
  await fs.mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
  await fs.chmod(SOCKET_DIR, 0o700).catch(() => {
    logger.warn('failed to enforce socket directory permissions', { socketDir: SOCKET_DIR });
  });

  authToken = await resolveAuthToken();
  if (AUTH_REQUIRED && !authToken) {
    throw new Error('IPC authentication is enabled but no auth token is available');
  }
  await ensureSocketPathAvailable(SOCKET_PATH);

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    connectedSockets.add(socket);

    if (!AUTH_REQUIRED) {
      sendStatus(socket);
    }

    let buffer = '';

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RPC_LINE_BYTES) {
        logger.warn('socket input exceeded max line length; closing client', {
          maxLineBytes: MAX_RPC_LINE_BYTES,
        });
        const response: JsonRpcResponse = {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'RPC line too long' },
        };
        socket.write(JSON.stringify(response) + '\n');
        socket.destroy();
        return;
      }

      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);

        if (line) {
          const req = parseRequest(line);
          let response: JsonRpcResponse | null;

          try {
            response = req
              ? handleRequest(req, socket)
              : { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
          } catch (err) {
            logger.error('request handler error', {
              error: err instanceof Error ? err.message : String(err),
            });
            response = { jsonrpc: '2.0', id: req?.id ?? null, error: { code: -32603, message: 'Internal error' } };
          }

          if (response) socket.write(JSON.stringify(response) + '\n');
        }

        nl = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      connectedSockets.delete(socket);
      authenticatedSockets.delete(socket);
    });
    socket.on('error', (err) => {
      connectedSockets.delete(socket);
      authenticatedSockets.delete(socket);
      logger.error('socket error', { message: err.message });
    });
  });

  activeServer = server;

  server.listen(SOCKET_PATH, () => {
    void fs.chmod(SOCKET_PATH, 0o600).catch(() => {
      logger.warn('failed to enforce socket file permissions', { socketPath: SOCKET_PATH });
    });
    logger.info('orchestrator listening', {
      socketPath: SOCKET_PATH,
      logPath: getLogPath(),
      pid: process.pid,
      authRequired: AUTH_REQUIRED,
      authTokenPath: AUTH_REQUIRED ? AUTH_TOKEN_PATH : null,
      maxRpcLineBytes: MAX_RPC_LINE_BYTES,
    });
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(0));
  }
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { message: err.message, stack: err.stack });
    void shutdown(1);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('unhandled rejection', { error: String(err) });
    void shutdown(1);
  });
}

await startServer();
