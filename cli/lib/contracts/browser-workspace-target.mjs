import { isDureDomainIdV1 } from "./protocol-identity.mjs";

const fields = ["resource_id", "generation", "workspace_id"];
const sameResource = (left, right) => fields.every((key) => left?.[key] === right?.[key]);

/** Wire projection of the Hmux workspace selection owner. */
export function parseBrowserWorkspaceTarget(value) {
  if (!value || !isDureDomainIdV1(value.workspace_id) || !isDureDomainIdV1(value.generation)
      || typeof value.revision !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.revision)
      || BigInt(value.revision) > 18446744073709551615n) return null;
  const current = value.current_resource;
  if (current !== null && (!current || !fields.every((key) => isDureDomainIdV1(current[key]))
      || current.workspace_id !== value.workspace_id || current.generation !== value.generation)) return null;
  return { workspace_id: value.workspace_id, generation: value.generation, revision: value.revision,
    current_resource: current === null ? null : { resource_id: current.resource_id, generation: current.generation, workspace_id: current.workspace_id } };
}

/** Validate selection and inventory together before choosing or changing a target. */
export function parseBrowserWorkspaceCatalogTarget(catalog) {
  const target = parseBrowserWorkspaceTarget(catalog?.target);
  if (!target || catalog.workspace_id !== target.workspace_id || !Array.isArray(catalog.resources)) return null;
  const ids = new Set();
  for (const row of catalog.resources) {
    const resource = row?.resource;
    if (!resource || !fields.every((key) => isDureDomainIdV1(resource[key]))
        || resource.workspace_id !== target.workspace_id || resource.generation !== target.generation
        || ids.has(resource.resource_id)) return null;
    ids.add(resource.resource_id);
  }
  if (target.current_resource !== null && !catalog.resources.some((row) => sameResource(row.resource, target.current_resource))) return null;
  return target;
}

/** A successful CAS changes at most one revision; selecting the same target is a no-op. */
export function browserWorkspaceSelectionResult(expected, resource, value) {
  const actual = parseBrowserWorkspaceTarget(value);
  const revision = BigInt(expected.revision) + (sameResource(expected.current_resource, resource) ? 0n : 1n);
  return actual && actual.workspace_id === expected.workspace_id && actual.generation === expected.generation
    && actual.revision === String(revision) && sameResource(actual.current_resource, resource) ? actual : null;
}
