/**
 * What is actually installed for the packages a project declares: the version, the license and any
 * install scripts. Reads `node_modules/<name>/package.json` only, so it costs one small file per
 * direct dependency and nothing when dependencies are not installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { licenseRisk } from '../shared/licenses.js';
import type { LicenseRisk } from '../shared/types.js';

export interface InstalledInfo {
  version?: string;
  license?: string;
  licenseRisk: LicenseRisk;
  installScripts?: string[];
}

interface InstalledManifest {
  version?: unknown;
  license?: unknown;
  licenses?: unknown;
  scripts?: Record<string, unknown>;
  gypfile?: unknown;
}

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

/** `"MIT"`, `{ type: "MIT" }` and the old `licenses: [{ type }]` form, as one SPDX expression. */
function licenseOf(pkg: InstalledManifest): string | undefined {
  const one = (value: unknown): string | undefined => (typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string' ? (value as { type: string }).type : undefined);
  const single = one(pkg.license);
  if (single) return single;
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(one).filter((l): l is string => !!l);
    if (all.length) return all.join(' OR ');
  }
  return undefined;
}

function infoOf(pkg: InstalledManifest): InstalledInfo {
  const license = licenseOf(pkg);
  const scripts = INSTALL_HOOKS.filter((hook) => typeof pkg.scripts?.[hook] === 'string');
  // A binding.gyp is built by node-gyp at install time even without an install script.
  if (pkg.gypfile === true && !scripts.includes('install')) scripts.push('install');
  return {
    version: typeof pkg.version === 'string' ? pkg.version : undefined,
    license,
    licenseRisk: licenseRisk(license),
    ...(scripts.length ? { installScripts: scripts } : {}),
  };
}

/** Parsed manifests by file, valid while the file's modification time is unchanged (`serve` re-analyzes on every save). */
const memo = new Map<string, { mtimeMs: number; info: InstalledInfo | undefined }>();

function readManifest(file: string): InstalledInfo | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const cached = memo.get(file);
  if (cached?.mtimeMs === mtimeMs) return cached.info;
  let info: InstalledInfo | undefined;
  try {
    info = infoOf(JSON.parse(fs.readFileSync(file, 'utf8')) as InstalledManifest);
  } catch {
    info = undefined;
  }
  memo.set(file, { mtimeMs, info });
  return info;
}

/**
 * Installed details of the given packages. `dirs` are the project-relative directories whose
 * `node_modules` may hold them: the root first (hoisting), then workspaces.
 */
export function readInstalled(root: string, dirs: string[], names: string[]): Map<string, InstalledInfo> {
  const found = new Map<string, InstalledInfo>();
  const folders = [...new Set(['', ...dirs])].map((d) => path.join(root, d, 'node_modules'));
  for (const name of names) {
    for (const folder of folders) {
      const info = readManifest(path.join(folder, name, 'package.json'));
      if (info) {
        found.set(name, info);
        break;
      }
    }
  }
  return found;
}
