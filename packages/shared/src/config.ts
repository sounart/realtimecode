import os from 'node:os';
import path from 'node:path';

export type AppConfig = {
  socketPath: string;
  logLevel: string;
};

const runtimeDir = path.join(os.homedir(), '.runtime', 'realtimecode');

export const config: AppConfig = {
  socketPath: process.env.RTC_SOCKET_PATH ?? path.join(runtimeDir, 'orchestrator.sock'),
  logLevel: process.env.RTC_LOG_LEVEL ?? 'info'
};
