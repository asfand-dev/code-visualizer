/**
 * Terminal output helpers for the query commands: clickable `file:line` links (OSC 8 hyperlinks that
 * open the editor), tree drawing, repository text made safe for terminals, writing a command's output,
 * and small text utilities.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { terminalSafe, terminalSafeDeep } from '../shared/terminal-safe.js';
import { copyToClipboard, isTTY } from './shared.js';

/**
 * Repository text (paths, symbols, commit subjects, author names) for terminal output: control characters
 * shown, never sent (an ESC in a file name must not retitle the window or plant a link).
 */
export function safeText(text: string): string {
  return terminalSafe(text);
}

/** A copy of a report with every string in it made terminal-safe (for the text formatters; JSON and Markdown stay exact). */
export function safeData<T>(value: T): T {
  return terminalSafeDeep(value);
}

export interface LinkOptions {
  /** Absolute project root (file ids are relative to it). */
  root: string;
  /** Emit OSC 8 hyperlinks (default: when `stream` is a TTY and the terminal is not "dumb"). */
  enabled?: boolean;
  stream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

/**
 * The editor URL for a file and line. `CODE_VISUALIZER_EDITOR` picks the editor: vscode (default),
 * cursor, windsurf, vscodium, zed, webstorm, idea, file, none — or a template with `{file}`, `{line}`
 * and `{column}`, e.g. `subl://open?url=file://{file}&line={line}`.
 */
export function editorLink(absFile: string, line: number | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const editor = (env.CODE_VISUALIZER_EDITOR ?? 'vscode').trim();
  const l = line ?? 1;
  const posix = absFile.replace(/\\/g, '/');
  const slashed = posix.startsWith('/') ? posix : `/${posix}`;
  // encodeURI keeps `#` and `?`, which would start a fragment or query in the URL.
  const encodeURI = (p: string): string => globalThis.encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (editor.includes('{file}')) {
    return editor.replace(/\{file\}/g, encodeURI(posix)).replace(/\{line\}/g, String(l)).replace(/\{column\}/g, '1');
  }
  switch (editor.toLowerCase()) {
    case '':
    case 'code':
    case 'vscode':
      return `vscode://file${encodeURI(slashed)}:${l}:1`;
    case 'code-insiders':
    case 'vscode-insiders':
      return `vscode-insiders://file${encodeURI(slashed)}:${l}:1`;
    case 'vscodium':
      return `vscodium://file${encodeURI(slashed)}:${l}:1`;
    case 'cursor':
      return `cursor://file${encodeURI(slashed)}:${l}:1`;
    case 'windsurf':
      return `windsurf://file${encodeURI(slashed)}:${l}:1`;
    case 'zed':
      return `zed://file${encodeURI(slashed)}:${l}`;
    case 'webstorm':
    case 'idea':
    case 'phpstorm':
    case 'pycharm':
      return `${editor.toLowerCase()}://open?file=${encodeURIComponent(posix)}&line=${l}`;
    case 'file':
      return pathToFileURL(absFile).href;
    case 'none':
    case 'off':
      return undefined;
    default:
      return `vscode://file${encodeURI(slashed)}:${l}:1`;
  }
}

/** An environment flag that is set to something other than `0`, `false` or `no`. */
function flagSet(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false' && v !== 'no';
}

/** Wrap `text` in an OSC 8 hyperlink to `url` (both made terminal-safe: neither may end the sequence early). */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${terminalSafe(url).replace(/[\s]/g, encodeURIComponent)}\x1b\\${terminalSafe(text)}\x1b]8;;\x1b\\`;
}

export type Linker = (file: string, line?: number, label?: string) => string;

/** Prints `file:line`, clickable on terminals that support hyperlinks. */
export function createLinker(options: LinkOptions): Linker {
  const env = options.env ?? process.env;
  const enabled = options.enabled ?? (isTTY(options.stream ?? process.stdout) && env.TERM !== 'dumb' && !flagSet(env.NO_HYPERLINKS));
  return (file, line, label) => {
    const text = terminalSafe(label ?? (line ? `${file}:${line}` : file));
    if (!enabled) return text;
    const url = editorLink(path.resolve(options.root, file), line, env);
    return url ? hyperlink(text, url) : text;
  };
}

export interface TreeNode {
  label: string;
  children?: TreeNode[];
}

/** Draw nested items with box-drawing guides (`├─`, `└─`, `│`). */
export function renderTree(nodes: TreeNode[], indent = '  '): string[] {
  const lines: string[] = [];
  const walk = (list: TreeNode[], prefix: string): void => {
    list.forEach((node, i) => {
      const last = i === list.length - 1;
      lines.push(`${indent}${prefix}${pc.dim(last ? '└─ ' : '├─ ')}${node.label}`);
      if (node.children?.length) walk(node.children, `${prefix}${last ? '   ' : pc.dim('│  ')}`);
    });
  };
  walk(nodes, '');
  return lines;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** `3d ago`, `5mo ago` */
export function ago(time: number, now = Date.now()): string {
  const days = Math.floor((now - time) / (24 * 3600 * 1000));
  if (days < 1) return 'today';
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y ago`;
}

/**
 * Write a command's output: to `--output` (creating its folder) and / or the clipboard (`clipboard`, when
 * that should differ from the text), else stdout. False when the file cannot be written — said in one line
 * on stderr (`reason`: how to name the error; default its message), no stack trace.
 */
export async function emitOutput(
  text: string,
  values: { output?: string; copy?: boolean },
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream },
  options: { clipboard?: string; quiet?: boolean; reason?: (error: NodeJS.ErrnoException) => string } = {},
): Promise<boolean> {
  const body = text.endsWith('\n') ? text : `${text}\n`;
  if (values.output) {
    try {
      const file = path.resolve(values.output);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    } catch (error) {
      const reason = options.reason ?? ((e: NodeJS.ErrnoException) => e.message);
      io.stderr.write(`${pc.red('✖')} Cannot write ${values.output}: ${reason(error as NodeJS.ErrnoException)}\n`);
      return false;
    }
    if (!options.quiet) io.stderr.write(`${pc.green('✔')} Wrote ${values.output}\n`);
  }
  if (values.copy) {
    const ok = await copyToClipboard(options.clipboard ?? text);
    io.stderr.write(ok ? `${pc.green('✔')} Copied to the clipboard\n` : `${pc.yellow('!')} Could not access the clipboard\n`);
  }
  if (!values.output && !values.copy) io.stdout.write(body);
  return true;
}

/** At most `max` items, plus a dim "+N more" line. */
export function capped<T>(items: T[], max: number, render: (item: T) => string, indent = '  '): string[] {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push(`${indent}${pc.dim(`+${items.length - max} more (use --json for all)`)}`);
  return lines;
}
