/**
 * The backend half of a report's `source`, as `--json` consumers see it.
 *
 * `response.backend` is the transport's validated handshake: identity,
 * generation, protocol, observation time, and the backend's complete
 * capability list. Reports that embedded it verbatim repeated that list
 * (about a hundred strings on a current backend) in every receipt, which
 * buried the few fields an agent actually reads — a project id, an agent
 * id, a receipt state — under boilerplate it had to grep past.
 *
 * The identity and freshness fields stay as they were. The list collapses
 * to its size unless the caller asks for `verbose`; the capability check
 * the list fed already ran inside the transport before the response was
 * accepted, so omitting it from the receipt removes evidence of nothing
 * the receipt decides.
 */
export function backendSourceSummary(backend, { verbose = false } = {}) {
  if (backend === null || typeof backend !== "object" || Array.isArray(backend)) {
    return backend;
  }
  const { capabilities, ...identity } = backend;
  const list = Array.isArray(capabilities) ? capabilities : [];
  return verbose
    ? { ...identity, capabilityCount: list.length, capabilities: [...list] }
    : { ...identity, capabilityCount: list.length };
}
