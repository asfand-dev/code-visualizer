/** What went wrong, for callers that react to one case (`unknown-ref`: a `--base` / `"base"` that names no commit). */
export type AnalyzeErrorCode = 'unknown-ref';

/**
 * A user-facing analysis failure (no sources, bad root, unknown ref, scope outside the project…):
 * the CLI prints the message and exits 1. Kept in its own module so CLI commands can recognise it
 * without loading the analyzer and the compiler.
 */
export class AnalyzeError extends Error {
  constructor(
    message?: string,
    readonly code?: AnalyzeErrorCode,
  ) {
    super(message);
  }
}
