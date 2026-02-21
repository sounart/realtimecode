import { Command } from 'commander';
import { runStart } from './commands/start.js';

const program = new Command();

program
  .name('realtimecode')
  .description('RealtimeCode CLI launcher')
  .version('0.1.0');

program
  .command('start')
  .description('Pick a working directory and initialize a local session scaffold')
  .action(async () => {
    try {
      await runStart();
    } catch (error) {
      if (error instanceof Error && error.name === 'ExitPromptError') {
        console.log('\nPrompt cancelled.');
        process.exitCode = 130;
        return;
      }

      throw error;
    }
  });

await program.parseAsync(process.argv);
