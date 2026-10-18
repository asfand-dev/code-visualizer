/**
 * Risky patterns in code: the rules, how secrets are recognised and how they are masked. Pure — the
 * analyzer's scanner and the report UI share it. A secret never leaves this module unmasked.
 */
import type { RawRisk, RiskFinding, RiskRule, RiskSeverity } from './types.js';

export interface RiskRuleInfo {
  severity: RiskSeverity;
  title: string;
  /** What to do about it. */
  advice: string;
}

export const RISK_RULES: Record<RiskRule, RiskRuleInfo> = {
  'hardcoded-secret': {
    severity: 'high',
    title: 'Hardcoded secret',
    advice: 'Rotate the credential (it is in your git history), then read it from an environment variable or a secret manager.',
  },
  'hardcoded-credential': {
    severity: 'medium',
    title: 'Hardcoded credential',
    advice: 'A password, key or token is assigned a literal value. Read it from the environment instead, and rotate it if it is real.',
  },
  eval: {
    severity: 'high',
    title: 'Dynamic code execution',
    advice: 'eval(), new Function() and string timers run whatever text they get. Use JSON.parse, a lookup table or a real function.',
  },
  'html-injection': {
    severity: 'medium',
    title: 'Unsafe HTML',
    advice: 'Raw HTML from a variable is a cross-site scripting risk. Render text, or sanitize it first (for example with DOMPurify).',
  },
  'shell-injection': {
    severity: 'high',
    title: 'Shell command built from a variable',
    advice: 'exec() runs its argument in a shell. Use execFile or spawn with an argument array so input is never parsed as a command.',
  },
  'sql-injection': {
    severity: 'high',
    title: 'SQL built from a variable',
    advice: 'Pass values as query parameters (`$1`, `?`, tagged templates) instead of putting them into the SQL text.',
  },
  'tls-disabled': {
    severity: 'high',
    title: 'Certificate checks disabled',
    advice: 'Turning off TLS verification allows man-in-the-middle attacks. Trust the right CA (NODE_EXTRA_CA_CERTS) instead.',
  },
};

export const SEVERITY_ORDER: Record<RiskSeverity, number> = { high: 0, medium: 1, low: 2 };

/** At most this many findings are kept in a report. */
export const MAX_RISKS = 300;

/** Credentials with a recognisable shape. The first capture group (or the whole match) is the secret. */
export const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'AWS access key', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/ },
  { label: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { label: 'Slack token', re: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/ },
  { label: 'Stripe live key', re: /\b([rs]k_live_[A-Za-z0-9]{16,})\b/ },
  { label: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/ },
  { label: 'SendGrid key', re: /\b(SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/ },
  { label: 'npm token', re: /\b(npm_[A-Za-z0-9]{36})\b/ },
  // The whole block, so masking a snippet hides the key material that follows the header too.
  { label: 'private key', re: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*))/ },
  { label: 'JSON Web Token', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/ },
  { label: 'connection string with a password', re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s:/@'"`]+:([^\s@/'"`]{3,})@/ },
];

/** Names whose value is a secret when it is a literal (`password`, `dbPassword`, `API_KEY`, `jwtSecret`…). */
export const CREDENTIAL_NAME_RE = /(password|passwd|passphrase|secret|secret[_-]?key|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|token)$|^pass$/i;

/** Words that start made-up values (`your-api-key`, `test_secret`, `changeme`), as whole words. */
const PLACEHOLDER_WORD_RE = /^(?:your|my|the|some|an?|example|sample|test|dummy|fake|mock|placeholder|changeme|change[_-]?me|replace|insert|enter|todo|none|null|undefined|xxx+)(?:[\s_.-]|$)/i;
const PLACEHOLDER_SYMBOL_RE = /^(?:\*+|\.\.\.|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%|process\.env)/;

/** The value is an obvious stand-in (`your-api-key`, `changeme`, `${TOKEN}`, `****`) rather than a credential. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (PLACEHOLDER_WORD_RE.test(v) || PLACEHOLDER_SYMBOL_RE.test(v)) return true;
  // One character repeated, or a word that only names the field (`'password'`, `'Password'`).
  return new Set(v.toLowerCase()).size <= 2 || /^(pass(word|wd)?|secret|token|api[_-]?key|username|user)$/i.test(v);
}

/** Shannon entropy in bits per character: random keys are above ~3.2, words and phrases below. */
export function entropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Random-looking text this long is a key, not a phrase. */
const KEY_LIKE_LENGTH = 16;
const KEY_LIKE_ENTROPY = 3.7;

/**
 * A literal assigned to a credential-named variable that is probably real: one token that is not a
 * placeholder, a path or a name, and either mixes letters with digits or looks random. Words joined by
 * separators (`access_token`, `authTokenKey`) are names of things, not secrets.
 */
export function looksLikeCredentialValue(value: string): boolean {
  if (value.length < 8 || value.length > 200 || /\s/.test(value) || isPlaceholder(value)) return false;
  if (/^(https?:\/\/|\/|\.\/|[\w.-]+\.(json|ts|js|png|svg|css)$)/i.test(value)) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return value.length >= KEY_LIKE_LENGTH && entropy(value) >= KEY_LIKE_ENTROPY;
}

/** Keys written for documentation: AWS's `AKIAIOSFODNN7EXAMPLE`, `AKIAXXXXXXXXXXXXXXXX`. A real key never repeats a character eight times. */
const DOCUMENTATION_KEY_RE = /EXAMPLE$|(.)\1{7,}/i;

/** The first recognisable secret in a string literal, or undefined. */
export function findSecret(value: string): { label: string; secret: string } | undefined {
  for (const { label, re } of SECRET_PATTERNS) {
    const match = re.exec(value);
    if (!match) continue;
    const secret = match[1] ?? match[0];
    if (!isPlaceholder(secret) && !DOCUMENTATION_KEY_RE.test(secret)) return { label, secret };
  }
  return undefined;
}

/** `AKIA…(20 characters)`: enough to find the secret, never enough to use it. */
export function maskSecret(secret: string): string {
  return `${secret.slice(0, Math.min(4, Math.floor(secret.length / 4)))}…(${secret.length} characters)`;
}

/** The text with every recognisable secret masked, so a code excerpt is safe to store and to show. */
export function maskSecretsIn(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    const global = new RegExp(re.source, 'g');
    out = out.replace(global, (match, group?: string) => {
      const secret = typeof group === 'string' ? group : match;
      return match.replace(secret, maskSecret(secret));
    });
  }
  return out;
}

/** Tests, fixtures, mocks and examples contain fake credentials and unsafe snippets on purpose. */
const TEST_CONTEXT_RE = /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|specs?|e2e|cypress|fixtures?|mocks?|examples?|samples?|stories|storybook|seeds?)\/|\.(test|spec|stories|story|mock)\.[cm]?[jt]sx?$/i;
export const isTestContext = (file: string): boolean => TEST_CONTEXT_RE.test(file);

/** Attach severity, the file and the test flag. */
export function toFindings(file: string, risks: RawRisk[], inTest: boolean): RiskFinding[] {
  return risks.map((r) => ({ ...r, severity: RISK_RULES[r.rule].severity, file, ...(inTest ? { test: true } : {}) }));
}

/** The project's own code first, test fixtures last (their fake credentials are noise); then by severity, file and line. */
export function sortFindings(findings: RiskFinding[]): RiskFinding[] {
  return findings.sort((a, b) => Number(!!a.test) - Number(!!b.test) || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}
