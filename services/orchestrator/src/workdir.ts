import path from 'node:path';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';

export interface WorkdirValidationResult {
  resolvedWorkdir: string | null;
  error: string | null;
}

export function validateWorkdir(input: string): WorkdirValidationResult {
  const resolved = path.resolve(input);

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch {
    return { resolvedWorkdir: null, error: `Workdir does not exist: ${resolved}` };
  }

  if (!stats.isDirectory()) {
    return { resolvedWorkdir: null, error: `Workdir is not a directory: ${resolved}` };
  }

  try {
    accessSync(resolved, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch {
    return { resolvedWorkdir: null, error: `Workdir is not readable, writable, and accessible: ${resolved}` };
  }

  return { resolvedWorkdir: resolved, error: null };
}
