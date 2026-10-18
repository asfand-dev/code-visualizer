import express from 'express';
import chalk from 'chalk';
import type { UserConfig } from 'vite';
import { config } from './config';
import { describeContext } from './cli/context';
import { summarize } from './complex';

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true, context: describeContext(), summary: summarize([1, 2, 3]) });
});

app.listen(config.port, () => {
  console.log(chalk.green(`listening on ${config.port}`));
});

export type ViteSettings = UserConfig;
