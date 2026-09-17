/** Quote one value as a literal POSIX shell word. Commands that intentionally
 * accept shell syntax must keep that syntax separate from dynamic values. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
