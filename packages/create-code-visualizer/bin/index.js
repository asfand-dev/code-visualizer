#!/usr/bin/env node
// `npm create code-visualizer [-- <command> <options>]` → the code-visualizer CLI.
import { runCli } from 'code-visualizer';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exitCode = 1;
  },
);
