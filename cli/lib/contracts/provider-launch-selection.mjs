/** Shared opaque provider tokens, safe to pass as quoted argv values. Models may
 * include provider namespaces, model variants, and context qualifiers such as [1m]. */
export function isProviderModelSelection(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._\[\]/:-]{0,255}$/u.test(value);
}

export function isProviderEffortSelection(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}
