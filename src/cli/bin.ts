import { runCli } from './run.js';

const argv = process.argv.slice(2);

/** Resolves once everything written to `stream` so far has been handed to the OS. */
const flushed = (stream: NodeJS.WriteStream): Promise<void> => new Promise((resolve) => stream.write('', () => resolve()));

runCli(argv).then(
  (code) => {
    process.exitCode = code;
    // A hook has answered: work still running past its deadline (an analysis) must not keep the agent waiting.
    if (argv[0] === 'hook') void Promise.all([flushed(process.stdout), flushed(process.stderr)]).then(() => process.exit(code));
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  },
);
