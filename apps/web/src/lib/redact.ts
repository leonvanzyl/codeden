/**
 * Masks secrets in short text the UI shows outside the transcript (the pixel scene's activity
 * bubbles): credentials in URLs, bearer and basic tokens, `key=value` pairs whose key names a
 * secret, well-known token formats (GitHub, OpenAI, Anthropic, Slack, GitLab, npm, AWS, Google)
 * and JWTs, and any long opaque string that looks like a key. Masked parts read `***`. It errs
 * on the side of hiding: a long hash in a message is masked too.
 */

const MASK = "***";

const RULES: [RegExp, string][] = [
  // https://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // Authorization: Bearer <token>, Basic <token>, token <token>
  [/\b(bearer|basic|token)(\s+|=|:\s*)[A-Za-z0-9._~+/=-]{8,}/gi, `$1$2${MASK}`],
  // api_key=..., password: "...", SECRET=...
  [
    /\b([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|pwd|credential|auth|private[_-]?key)[A-Za-z0-9_-]*)(\s*[=:]\s*)(?!\*{3})(?!(?:bearer|basic|token)\s)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
    `$1$2${MASK}`,
  ],
  // --token abc, -p hunter2
  [
    /(\s--?(?:api-?key|access-?key|secret|token|password|passwd|pwd|auth|p))(\s+)("[^"]*"|'[^']*'|[^\s"',;]+)/gi,
    `$1$2${MASK}`,
  ],
  // Well-known token formats.
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
    MASK,
  ],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Anything long and opaque (hex, base64) with letters and digits: 32 characters or more
  // without a break (a slash or a dot breaks it, so file paths stay readable).
  [/(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/g, MASK],
];

/** The text with every secret-looking part replaced by `***`. */
export function redactSecrets(text: string): string {
  return RULES.reduce((out, [pattern, replace]) => out.replace(pattern, replace), text);
}
