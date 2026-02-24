import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorkdir } from '../workdir.js';

describe('validateWorkdir', () => {
  it('rejects missing directories', () => {
    const missing = path.join(os.tmpdir(), `rtc-missing-${Date.now()}-${Math.random()}`);
    const result = validateWorkdir(missing);

    expect(result.resolvedWorkdir).toBeNull();
    expect(result.error).toContain('does not exist');
  });

  it('rejects non-directory paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-workdir-file-'));
    const filePath = path.join(dir, 'file.txt');
    fs.writeFileSync(filePath, 'test');

    const result = validateWorkdir(filePath);

    expect(result.resolvedWorkdir).toBeNull();
    expect(result.error).toContain('not a directory');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts readable writable directories and resolves absolute path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-workdir-ok-'));
    const relativePath = path.relative(process.cwd(), dir) || dir;

    const result = validateWorkdir(relativePath);

    expect(result.error).toBeNull();
    expect(result.resolvedWorkdir).toBe(path.resolve(relativePath));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects directories without execute permission', () => {
    if (process.platform === 'win32') return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-workdir-noexec-'));
    fs.chmodSync(dir, 0o600);

    const result = validateWorkdir(dir);

    expect(result.resolvedWorkdir).toBeNull();
    expect(result.error).toContain('accessible');

    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
