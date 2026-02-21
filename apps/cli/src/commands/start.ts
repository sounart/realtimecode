import { select, input } from '@inquirer/prompts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '@realtimecode/shared';

type DirectoryOption = {
  name: string;
  value: string;
};

async function discoverDirectories(baseDir: string): Promise<DirectoryOption[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      value: path.join(baseDir, entry.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function runStart(): Promise<void> {
  const cwd = process.cwd();
  const dirs = await discoverDirectories(cwd);

  const selected = await select({
    message: 'Pick a working directory for RealtimeCode:',
    choices: [
      ...dirs.map((dir) => ({ name: dir.name, value: dir.value })),
      { name: 'Use current directory', value: cwd },
      { name: 'Enter a custom path', value: '__custom__' }
    ],
    pageSize: 12
  });

  const workdir =
    selected === '__custom__'
      ? await input({
          message: 'Enter an absolute directory path:',
          validate: async (value) => {
            if (!path.isAbsolute(value)) {
              return 'Path must be absolute.';
            }

            try {
              const stat = await fs.stat(value);
              return stat.isDirectory() ? true : 'Path is not a directory.';
            } catch {
              return 'Directory does not exist.';
            }
          }
        })
      : selected;

  console.log('RealtimeCode session bootstrapped');
  console.log(`- workdir: ${workdir}`);
  console.log(`- socket : ${config.socketPath}`);
}
