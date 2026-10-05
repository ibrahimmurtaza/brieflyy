/**
 * Recognise a live credential in a line of text.
 *
 * Deliberately conservative about what counts as a secret: the point is to stop
 * a real key reaching the repository, not to object to the placeholder values in
 * `.env.example` and the test fixtures that stand in for them.
 */

export interface CredentialMatch {
  readonly rule: string;
  readonly line: number;
  readonly text: string;
}

interface CredentialPattern {
  readonly rule: string;
  readonly pattern: RegExp;
}

/** Provider formats, matched wherever they appear in a line. */
const PROVIDER_PATTERNS: readonly CredentialPattern[] = [
  { rule: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { rule: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{10,}/ },
  { rule: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { rule: 'Resend API key', pattern: /\bre_[0-9A-Za-z]{16,}/ },
  { rule: 'Stripe secret key', pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { rule: 'Stripe webhook signing secret', pattern: /\bwhsec_[A-Za-z0-9]{32,}/ },
  { rule: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { rule: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'private key', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
];

/** Names that make an assignment a secret no matter what the value looks like. */
const SECRET_NAME_RE =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)S?)\b\s*[:=]\s*(.+)$/;

const MIN_SECRET_LENGTH = 12;

/**
 * Words that only ever turn up in a stand-in value. A value is a placeholder
 * when every word in it is one of these, which is checked word by word so that
 * `dev-only-change-me-plus-a-real-key` is not mistaken for one.
 */
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  'x', 'xxx', 'change', 'changeme', 'me', 'replace', 'insert', 'your', 'yours', 'my', 'own',
  'value', 'key', 'secret', 'token', 'id', 'example', 'placeholder', 'redacted', 'dummy',
  'fake', 'mock', 'dev', 'test', 'testing', 'local', 'ci', 'sample', 'todo', 'tbd', 'none',
  'null', 'nil', 'undefined', 'empty', 'only', 'notreal', 'here', 'goes', 'below', 'do',
  'not', 'set', 'unset', 'fixme',
]);

function looksLikePlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  // The usual filler: one character repeated, or nothing but punctuation.
  if (/^([x*._-])\1*$/.test(trimmed)) return true;
  if (/^[*.\-_<>{}\s'"]+$/.test(trimmed)) return true;
  const words = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return true;
  return words.every((word) => /^\d+$/.test(word) || PLACEHOLDER_WORDS.has(word));
}

function secretValueFromAssignment(line: string): string | null {
  const match = SECRET_NAME_RE.exec(line);
  if (!match) return null;
  const value = (match[2] ?? '').trim().replace(/^["']|["'];?$/g, '');
  if (value.length < MIN_SECRET_LENGTH) return null;
  if (looksLikePlaceholder(value)) return null;
  // An interpolation, a process lookup, or a computed value is not a credential
  // written down in the source. Anything that is not a plain literal is a
  // computed value: a name that merely ends in `API_KEY` is a name, and what
  // follows it is code — `{ OPENAI_API_KEY: opts.apiKey }` is a lookup, not a
  // key. Only a literal is something somebody could have pasted in.
  if (/^[$({]/.test(value) || value.includes('(')) return null;
  if (!/^[\w.~+/=@-]+$/.test(value)) return null;
  return value;
}

/**
 * A line carrying this comment is one the author has looked at and means to
 * commit — a fixture for this file's own tests, say. Nothing else is exempt.
 */
export const ALLOW_MARKER = 'secret-scan:allow';

function isAllowed(line: string): boolean {
  return line.includes(ALLOW_MARKER);
}

/** Every credential in a block of added text, in line order. */
export function findCredentials(text: string): CredentialMatch[] {
  const found: CredentialMatch[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (isAllowed(line)) continue;
    for (const { rule, pattern } of PROVIDER_PATTERNS) {
      if (pattern.test(line)) {
        found.push({ rule, line: index + 1, text: line.trim() });
      }
    }
    const assigned = secretValueFromAssignment(line);
    if (assigned !== null && !found.some((m) => m.line === index + 1)) {
      found.push({ rule: 'secret assignment', line: index + 1, text: line.trim() });
    }
  }
  return found;
}

export interface StagedFile {
  readonly path: string;
  readonly text: string;
}

/** Files that hold local configuration and must never be committed. */
const NEVER_COMMIT = [/^\.env$/, /^\.env\.(?!example$)/];

export function isNeverCommitted(path: string): boolean {
  const normalised = path.replace(/\\/g, '/');
  return NEVER_COMMIT.some((re) => re.test(normalised));
}

export interface ScanResult {
  readonly files: readonly { readonly path: string; readonly matches: readonly CredentialMatch[] }[];
  readonly forbidden: readonly string[];
}

export function scanStagedFiles(files: readonly StagedFile[]): ScanResult {
  const flagged = files
    .map((file) => ({ path: file.path, matches: findCredentials(file.text) }))
    .filter((file) => file.matches.length > 0);
  return {
    files: flagged,
    forbidden: files.filter((file) => isNeverCommitted(file.path)).map((file) => file.path),
  };
}

export function describeScan(result: ScanResult): string {
  const lines: string[] = [];
  for (const path of result.forbidden) {
    lines.push(`  ${path}: a local environment file must never be committed`);
  }
  for (const file of result.files) {
    for (const match of file.matches) {
      lines.push(`  ${file.path}:${match.line}: looks like a ${match.rule}: ${match.text}`);
    }
  }
  if (lines.length === 0) return 'No credentials staged.';
  return ['Credential-shaped values are staged for commit:', ...lines].join('\n');
}
