/** Builds the context block printed by the CLI (not a React context). */
export function describeContext(): string {
  return `node ${process.version}`;
}
