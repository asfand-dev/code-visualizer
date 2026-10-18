/**
 * Environment variables: what the code reads, what the dotenv files declare, and what is missing.
 * Pure — the CLI, the report UI and the analyzer share it. Only names are ever handled, never values.
 */
import type { EnvFile, EnvRead, EnvReport, EnvUse, EnvVar } from './types.js';

/** At most this many reads are kept per variable (`EnvVar.useCount` has the real number). */
export const MAX_ENV_USES = 30;

/** Prefixes that make a framework put the variable into the browser bundle. */
const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'NUXT_PUBLIC_', 'VITE_', 'REACT_APP_', 'VUE_APP_', 'PUBLIC_', 'EXPO_PUBLIC_', 'GATSBY_', 'NG_APP_', 'STORYBOOK_'];

/** Provided by the runtime, the shell or a CI / hosting platform: nobody has to write them in `.env.example`. */
const PLATFORM_NAMES = new Set([
  'NODE_ENV', 'CI', 'HOME', 'PATH', 'PWD', 'USER', 'USERNAME', 'SHELL', 'TERM', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ',
  'NODE_OPTIONS', 'FORCE_COLOR', 'NO_COLOR', 'DEBUG', 'HOSTNAME', 'VERCEL', 'NETLIFY', 'NEXT_RUNTIME', 'NEXT_PHASE',
]);
const PLATFORM_PREFIXES = ['npm_', 'GITHUB_', 'GITLAB_', 'CI_', 'RUNNER_', 'VERCEL_', 'NETLIFY_', 'AWS_LAMBDA_', 'LAMBDA_', 'KUBERNETES_'];

/** Vite's own `import.meta.env` values. */
const VITE_BUILTINS = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);

const SECRET_NAME_RE = /(^|_)(SECRET|PRIVATE|PASSWORD|PASSWD|TOKEN|CREDENTIALS?|API_?KEY|ACCESS_?KEY|SERVICE_ROLE)(_|$)/i;
/** Names that contain a secret-like word but are public by design. */
const PUBLIC_BY_DESIGN_RE = /PUBLISHABLE|PUBLIC_?KEY|ANON/i;

export const isPlatformEnv = (name: string): boolean => PLATFORM_NAMES.has(name) || PLATFORM_PREFIXES.some((p) => name.startsWith(p));
export const hasPublicPrefix = (name: string): boolean => PUBLIC_PREFIXES.some((p) => name.startsWith(p));
export const isSecretName = (name: string): boolean => SECRET_NAME_RE.test(name);

/** A dotenv file that is meant to be committed as documentation of the variables. */
export const isEnvTemplateName = (fileName: string): boolean => /(^|[./])(example|sample|template|defaults?)(\.|$)/i.test(fileName);

/** Variable names declared in dotenv text (`KEY=value`, `export KEY=value`); comments and values are ignored. */
export function parseEnvNames(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

export interface FileEnvReads {
  file: string;
  reads: EnvRead[];
}

interface Tally {
  variable: EnvVar;
  files: Set<string>;
  onlyImportMeta: boolean;
}

/** Join what the code reads with what the dotenv files declare. */
export function buildEnvReport(reads: FileEnvReads[], files: EnvFile[]): EnvReport {
  const tallies = new Map<string, Tally>();
  const tally = (name: string): Tally => {
    let t = tallies.get(name);
    if (!t) {
      t = { variable: { name, uses: [], useCount: 0, fileCount: 0, declaredIn: [], documented: false, required: false }, files: new Set(), onlyImportMeta: true };
      tallies.set(name, t);
    }
    return t;
  };

  for (const { file, reads: list } of reads) {
    for (const read of list) {
      const t = tally(read.name);
      const v = t.variable;
      v.useCount++;
      t.files.add(file);
      if (v.uses.length < MAX_ENV_USES) {
        const use: EnvUse = { file, line: read.line, access: read.access };
        if (read.fallback) use.fallback = true;
        v.uses.push(use);
      }
      if (!read.fallback) v.required = true;
      if (read.access === 'import.meta.env') v.exposed = true;
      else t.onlyImportMeta = false;
    }
  }
  for (const file of files) {
    for (const name of file.names) {
      const v = tally(name).variable;
      v.declaredIn.push(file.path);
      if (file.template) v.documented = true;
    }
  }

  const vars: EnvVar[] = [];
  for (const t of tallies.values()) {
    const v = t.variable;
    v.fileCount = t.files.size;
    v.uses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    const viteBuiltin = VITE_BUILTINS.has(v.name) && v.useCount > 0 && t.onlyImportMeta;
    if (isPlatformEnv(v.name) || viteBuiltin) v.platform = true;
    if (hasPublicPrefix(v.name)) v.exposed = true;
    if (viteBuiltin) delete v.exposed;
    if (isSecretName(v.name)) v.secretLike = true;
    vars.push(v);
  }
  vars.sort((a, b) => b.useCount - a.useCount || a.name.localeCompare(b.name));

  const used = vars.filter((v) => v.useCount > 0);
  return {
    vars,
    files,
    undocumented: used.filter((v) => v.required && !v.documented && !v.platform).map((v) => v.name).sort(),
    unused: vars.filter((v) => v.useCount === 0 && v.documented).map((v) => v.name).sort(),
    exposedSecrets: used.filter((v) => v.exposed && v.secretLike && !PUBLIC_BY_DESIGN_RE.test(v.name)).map((v) => v.name).sort(),
  };
}

export type EnvStatusKind = 'exposed-secret' | 'platform' | 'documented' | 'optional' | 'private-only' | 'undocumented';

export interface EnvStatus {
  kind: EnvStatusKind;
  /** Nothing to do about it. */
  ok: boolean;
  /** One phrase: why. */
  note: string;
}

/** Where a variable the code reads stands: documented for the team, optional, or a gap to close. */
export function envStatus(variable: EnvVar, report: EnvReport): EnvStatus {
  if (report.exposedSecrets.includes(variable.name)) return { kind: 'exposed-secret', ok: false, note: 'a secret that reaches the browser bundle' };
  if (variable.platform) return { kind: 'platform', ok: true, note: 'provided by the platform' };
  const template = report.files.find((f) => f.template && variable.declaredIn.includes(f.path));
  if (template) return { kind: 'documented', ok: true, note: `documented in ${template.path}` };
  if (!variable.required) return { kind: 'optional', ok: true, note: 'optional: the code has a default' };
  const local = variable.declaredIn[0];
  if (local) return { kind: 'private-only', ok: false, note: `only in ${local}, which is not shared` };
  return { kind: 'undocumented', ok: false, note: report.files.length ? 'not in any .env.example' : 'not in a .env.example (there is none)' };
}

export interface EnvExampleOptions {
  /** Only variables no template declares yet. */
  onlyMissing?: boolean;
}

const shortSites = (v: EnvVar): string => {
  const sites = v.uses.slice(0, 3).map((u) => `${u.file}:${u.line}`);
  const more = v.fileCount > 3 ? ` +${v.fileCount - 3} more` : '';
  return `${sites.join(', ')}${more}`;
};

/**
 * A `.env.example` written from the code: required variables first, then optional ones (the code has a
 * default), each with where it is read. Values are left empty on purpose.
 */
export function envExampleText(report: EnvReport, options: EnvExampleOptions = {}): string {
  const wanted = report.vars.filter((v) => v.useCount > 0 && !v.platform && (!options.onlyMissing || !v.documented));
  const section = (title: string, list: EnvVar[]): string[] =>
    list.length
      ? [
          `# ${title}`,
          ...list.flatMap((v) => [`# ${shortSites(v)}${v.exposed ? ' · exposed to the browser' : ''}`, `${v.name}=`]),
          '',
        ]
      : [];
  const required = wanted.filter((v) => v.required).sort((a, b) => a.name.localeCompare(b.name));
  const optional = wanted.filter((v) => !v.required).sort((a, b) => a.name.localeCompare(b.name));
  const lines = ['# Generated by code-visualizer from the code. Review it before committing; values are never read.', '', ...section('Required: the code has no default', required), ...section('Optional: the code has a default', optional)];
  return `${lines.join('\n').trimEnd()}\n`;
}
