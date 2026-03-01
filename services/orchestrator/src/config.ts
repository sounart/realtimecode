import path from 'node:path';
import os from 'node:os';

// --- Parsing utilities ---

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const intVal = Math.floor(parsed);
  if (intVal < min || intVal > max) return fallback;
  return intVal;
}

function parseBoundedFloat(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseWordSet(raw: string | undefined, fallback: string[]): Set<string> {
  if (!raw) return new Set(fallback);
  const words = raw.split(',').map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
  return words.length > 0 ? new Set(words) : new Set(fallback);
}

// --- Socket & Auth ---

export const SOCKET_PATH = process.env['RTC_SOCKET_PATH']
  ?? path.join(os.homedir(), '.runtime', 'realtimecode', 'orchestrator.sock');
export const SOCKET_DIR = path.dirname(SOCKET_PATH);
export const AUTH_REQUIRED = process.env['RTC_AUTH_REQUIRED'] !== '0';
export const AUTH_TOKEN_PATH = process.env['RTC_AUTH_TOKEN_PATH']
  ?? path.join(SOCKET_DIR, 'orchestrator.token');

// --- Server limits ---

export const MAX_RPC_LINE_BYTES = parseBoundedInt(
  process.env['RTC_MAX_RPC_LINE_BYTES'],
  1_048_576,
  8_192,
  8_388_608,
);
export const MAX_AUDIO_CHUNK_BASE64_CHARS = parseBoundedInt(
  process.env['RTC_MAX_AUDIO_CHUNK_BASE64_CHARS'],
  256_000,
  4_096,
  2_000_000,
);
export const LOG_INSTRUCTION_PREVIEW = process.env['RTC_LOG_INSTRUCTION_PREVIEW'] === '1';

// --- Transcript processing ---

export const TRANSCRIPT_COMMIT_DELAY_MS = parseBoundedInt(
  process.env['RTC_TRANSCRIPT_COMMIT_DELAY_MS'],
  750,
  100,
  5_000,
);
export const MIN_EXECUTABLE_TRANSCRIPT_CHARS = parseBoundedInt(
  process.env['RTC_MIN_EXECUTABLE_TRANSCRIPT_CHARS'],
  8,
  1,
  200,
);
export const MIN_EXECUTABLE_TRANSCRIPT_WORDS = parseBoundedInt(
  process.env['RTC_MIN_EXECUTABLE_TRANSCRIPT_WORDS'],
  2,
  1,
  20,
);
export const MAX_PENDING_INSTRUCTIONS = parseBoundedInt(
  process.env['RTC_MAX_PENDING_INSTRUCTIONS'],
  8,
  1,
  128,
);
export const TRANSCRIPT_DEDUPE_WINDOW_MS = parseBoundedInt(
  process.env['RTC_TRANSCRIPT_DEDUPE_WINDOW_MS'],
  4_000,
  500,
  30_000,
);

// --- Instruction prefix ---

const DEFAULT_CODEX_INSTRUCTION_PREFIX = [
  'Execution policy:',
  '- Assume macOS/BSD userland unless proven otherwise.',
  '- Do not use Linux-only helpers like `timeout` or `setsid`.',
  '- For `ps`, use BSD-safe fields like `pid=,ppid=,stat=,command=` (not `cmd=`).',
  '- If a request asks to start or run a long-lived process (server/dev watcher/daemon), DO NOT rely on plain `nohup ... &`.',
  '- Use a robust detached spawn with Node: `node -e` + `child_process.spawn(..., { detached: true, stdio: ["ignore", out, err] })` and `child.unref()`.',
  '- Persist process metadata: write PID file and log file paths.',
  '- After launch, verify from a separate command with retry (for example: `lsof` and `curl`) before reporting success.',
  '- Include PID file path, log path, and verification result in your final response.',
  '- If verification fails, inspect logs/process state and retry with corrected launch strategy instead of asking the user.',
  '- Do not ask clarifying questions when the user intent is actionable; execute directly and report what happened.',
].join('\n');
export const CODEX_INSTRUCTION_PREFIX = process.env['RTC_CODEX_INSTRUCTION_PREFIX']?.trim()
  || DEFAULT_CODEX_INSTRUCTION_PREFIX;

// --- Word lists ---

const DEFAULT_FILLER_WORDS = [
  'ah', 'eh', 'er', 'hmm', 'huh', 'mm', 'mmm', 'uh', 'uhh', 'um',
];
export const FILLER_WORDS: ReadonlySet<string> = parseWordSet(
  process.env['RTC_FILLER_WORDS'],
  DEFAULT_FILLER_WORDS,
);

const DEFAULT_SHORT_COMMAND_WORDS = [
  'add', 'build', 'cancel', 'commit', 'continue', 'deploy', 'fix',
  'lint', 'pull', 'push', 'quit', 'run', 'start', 'status', 'stop', 'test',
];
export const SHORT_COMMAND_WORDS: ReadonlySet<string> = parseWordSet(
  process.env['RTC_SHORT_COMMAND_WORDS'],
  DEFAULT_SHORT_COMMAND_WORDS,
);

// --- Transcriber defaults ---

export const DEFAULT_REALTIME_URL_BASE = 'wss://api.openai.com/v1/realtime';
export const DEFAULT_REALTIME_SESSION_MODEL = 'gpt-realtime';
export const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
export const TRANSCRIPTION_MODEL_PATTERN = /^(whisper-1|gpt-4o(?:-mini)?-transcribe(?:-\d{4}-\d{2}-\d{2})?)$/;
export const MAX_PENDING_AUDIO_CHUNKS = 64;
export const MAX_TRACKED_EMITTED_ITEMS = 2_048;

export const DEFAULT_VAD_THRESHOLD = parseBoundedFloat(
  process.env['RTC_VAD_THRESHOLD'],
  0.5,
  0.0,
  1.0,
);
export const DEFAULT_SILENCE_DURATION_MS = parseBoundedInt(
  process.env['RTC_SILENCE_DURATION_MS'],
  800,
  100,
  5_000,
);
export const DEFAULT_PREFIX_PADDING_MS = parseBoundedInt(
  process.env['RTC_PREFIX_PADDING_MS'],
  300,
  0,
  3_000,
);
export const MAX_RECONNECT_ATTEMPTS = parseBoundedInt(
  process.env['RTC_MAX_RECONNECT_ATTEMPTS'],
  5,
  1,
  20,
);
export const MAX_RECONNECT_DELAY_MS = parseBoundedInt(
  process.env['RTC_MAX_RECONNECT_DELAY_MS'],
  30_000,
  1_000,
  120_000,
);

// --- Codex runner defaults ---

export const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex-spark';
export const DEFAULT_CODEX_SANDBOX_MODE = 'danger-full-access';
export const CODEX_TIMEOUT_MS = parseBoundedInt(
  process.env['RTC_CODEX_TIMEOUT_MS'],
  120_000,
  10_000,
  600_000,
);
export const CODEX_KILL_GRACE_MS = parseBoundedInt(
  process.env['RTC_CODEX_KILL_GRACE_MS'],
  1_500,
  100,
  30_000,
);
