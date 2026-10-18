/**
 * What a license obliges you to do, from its SPDX identifier. Pure. This is a triage aid, not legal
 * advice: it tells you which packages are worth a closer look.
 */
import type { LicenseRisk } from './types.js';

const PERMISSIVE = /^(MIT|MIT-0|ISC|BSD-[0-9]-Clause|0BSD|Apache-2\.0|Apache-1\.1|Unlicense|CC0-1\.0|Zlib|BlueOak-1\.0\.0|Python-2\.0|PSF-2\.0|CC-BY-[0-9.]+|WTFPL|X11|Artistic-2\.0|BSL-1\.0|Unicode-[0-9A-Z-]+|UPL-1\.0|MS-PL)$/i;
const WEAK_COPYLEFT = /^(LGPL-[0-9.]+(-only|-or-later)?|MPL-[0-9.]+|EPL-[0-9.]+|CDDL-[0-9.]+|EUPL-[0-9.]+|OSL-[0-9.]+|CPL-[0-9.]+|MS-RL)$/i;
const COPYLEFT = /^(A?GPL-[0-9.]+(-only|-or-later)?|SSPL-[0-9.]+|OSL-3\.0|CC-BY-SA-[0-9.]+|CC-BY-NC[A-Z-]*-[0-9.]+|BUSL-[0-9.]+)$/i;

/** Worst first: an `AND` takes the stricter side, an `OR` the looser one. */
const STRICTNESS: LicenseRisk[] = ['permissive', 'weak-copyleft', 'copyleft', 'proprietary', 'unknown'];
const rank = (risk: LicenseRisk): number => STRICTNESS.indexOf(risk);

function atom(id: string): LicenseRisk {
  const name = id.replace(/\+$/, '').trim();
  if (!name) return 'unknown';
  if (/^(UNLICENSED|SEE LICENSE IN.*|LicenseRef-.*|Proprietary|Commercial)$/i.test(name)) return 'proprietary';
  if (PERMISSIVE.test(name)) return 'permissive';
  if (WEAK_COPYLEFT.test(name)) return 'weak-copyleft';
  if (COPYLEFT.test(name)) return 'copyleft';
  return 'unknown';
}

/** The strictest obligation a license expression can impose, choosing the loosest side of every `OR`. */
export function licenseRisk(expression: string | undefined): LicenseRisk {
  if (!expression?.trim()) return 'unknown';
  const clean = expression.replace(/[()]/g, ' ');
  const choices = clean.split(/\s+OR\s+/i).map((alternative) => {
    const parts = alternative.split(/\s+AND\s+/i).map((part) => atom(part.trim().split(/\s+WITH\s+/i)[0]));
    return parts.reduce((worst, risk) => (rank(risk) > rank(worst) ? risk : worst), 'permissive' as LicenseRisk);
  });
  return choices.reduce((best, risk) => (rank(risk) < rank(best) ? risk : best));
}

/** Licenses that deserve a look before shipping: anything that is not permissive. */
export const needsReview = (risk: LicenseRisk | undefined): boolean => !!risk && risk !== 'permissive';

export const LICENSE_RISK_LABEL: Record<LicenseRisk, string> = {
  permissive: 'Permissive',
  'weak-copyleft': 'Weak copyleft',
  copyleft: 'Copyleft',
  proprietary: 'Proprietary',
  unknown: 'Unknown',
};
