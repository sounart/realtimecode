import os from 'node:os';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

type LogLevel = 'info' | 'warn' | 'error';

const LOG_PATH = process.env['RTC_LOG_PATH']
  ?? path.join(os.homedir(), '.runtime', 'realtimecode', 'orchestrator.log');
const IS_TEST_ENV = process.env['NODE_ENV'] === 'test'
  || process.env['VITEST'] === 'true'
  || typeof process.env['VITEST_WORKER_ID'] === 'string';
const LOG_TO_STDOUT = process.env['RTC_LOG_STDOUT'] === '1'
  || (process.env['RTC_LOG_STDOUT'] !== '0' && !IS_TEST_ENV);
const LOG_FILE_REQUESTED = process.env['RTC_LOG_FILE'] === '1'
  || (process.env['RTC_LOG_FILE'] !== '0' && !IS_TEST_ENV);
let logToFile = LOG_FILE_REQUESTED;

if (logToFile) {
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  } catch {
    logToFile = false;
  }
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
  };
  if (meta && Object.keys(meta).length > 0) {
    payload['meta'] = meta;
  }

  const line = JSON.stringify(payload);

  if (LOG_TO_STDOUT) {
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  if (logToFile) {
    try {
      appendFileSync(LOG_PATH, `${line}\n`);
    } catch {
      // Logging should never crash orchestrator execution.
    }
  }
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    write('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    write('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    write('error', message, meta);
  },
};

export function getLogPath(): string {
  return LOG_PATH;
}
