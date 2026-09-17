export function encodeRef(snapshot, element) {
  const { page, revision } = snapshot;
  const { resource, page_id, document_revision } = page;
  const fields = [resource.resource_id, resource.generation, resource.workspace_id, page_id, document_revision, revision, element];
  return `@br1.${Buffer.from(JSON.stringify(fields)).toString("base64url")}`;
}

export function target(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("browser_selector_invalid");
  if (!value.trimStart().startsWith("@")) return { kind: "css", selector: value };
  if (!/^@br1\.[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("browser_reference_invalid");
  let fields;
  try { fields = JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")); }
  catch { throw new Error("browser_reference_invalid"); }
  if (!Array.isArray(fields) || fields.length !== 7 || fields.some((field) => typeof field !== "string")) throw new Error("browser_reference_invalid");
  const [resource_id, generation, workspace_id, page_id, document_revision, revision, element] = fields;
  return { kind: "reference", reference: { snapshot: { page: { resource: { resource_id, generation, workspace_id }, page_id, document_revision }, revision }, element } };
}
