const CLIENT_PRESENTATION_SCHEMA_VERSION = 3;
const RUNTIME_BINDING_SCHEMA_VERSION = 1;
export const MAX_SPACE_QUERY_SPACES = 64;
export const MAX_SPACE_QUERY_PANES_PER_SPACE = 128;
export const MAX_SPACE_QUERY_TOTAL_PANES = 512;

const MAX_ID_LENGTH = 512;
const MAX_LABEL_LENGTH = 256;
const WINDOW_LABEL = /^[A-Za-z0-9_-]{1,128}$/;
const PANE_TYPES = new Set([
  "agent",
  "terminal",
  "remote_terminal",
  "editor",
  "browser",
  "tool",
  "other",
]);
const RUNTIMES = new Set([
  "hmux_session_v1",
  "hmux_standalone_v1",
  "hmux_managed_v1",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

export function boundedString(value, maximum = MAX_ID_LENGTH) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseBinding(value) {
  if (value === null) return null;
  if (
    !exactKeys(
      value,
      new Set([
        "schemaVersion",
        "runtime",
        "source",
        "hostId",
        "workspaceId",
        "sessionId",
      ]),
    ) ||
    value.schemaVersion !== RUNTIME_BINDING_SCHEMA_VERSION ||
    !RUNTIMES.has(value.runtime) ||
    !["local", "ssh"].includes(value.source) ||
    !boundedString(value.hostId, 256) ||
    !boundedString(value.workspaceId) ||
    !boundedString(value.sessionId)
  ) {
    return undefined;
  }
  return value;
}

function parsePane(value, schemaVersion) {
  if (
    !exactKeys(
      value,
      new Set(["id", "type", "component", "agentId", "binding", ...(schemaVersion === 3 ? ["title"] : [])]),
    ) ||
    !boundedString(value.id) ||
    !PANE_TYPES.has(value.type) ||
    !(
      value.component === null ||
      boundedString(value.component, 128)
    ) ||
    !(value.agentId === null || boundedString(value.agentId)) ||
    (schemaVersion === 3 && !(value.title === null || boundedString(value.title, MAX_LABEL_LENGTH)))
  ) {
    return null;
  }
  const binding = parseBinding(value.binding);
  return binding === undefined ? null : { ...value, title: schemaVersion === 3 ? value.title : null, binding };
}

export function parseClientPresentation(value) {
  if (
    !exactKeys(
      value,
      new Set([
        "schemaVersion",
        "complete",
        "spaces",
        "limits",
        "truncation",
      ]),
    ) ||
    ![2, CLIENT_PRESENTATION_SCHEMA_VERSION].includes(value.schemaVersion) ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.spaces) ||
    value.spaces.length > MAX_SPACE_QUERY_SPACES ||
    !exactKeys(
      value.limits,
      new Set(["maxSpaces", "maxPanesPerSpace", "maxTotalPanes"]),
    ) ||
    value.limits.maxSpaces !== MAX_SPACE_QUERY_SPACES ||
    value.limits.maxPanesPerSpace !== MAX_SPACE_QUERY_PANES_PER_SPACE ||
    value.limits.maxTotalPanes !== MAX_SPACE_QUERY_TOTAL_PANES ||
    !exactKeys(
      value.truncation,
      new Set([
        "spaces",
        "panes",
        "omittedSpaceCount",
        "omittedPaneCount",
      ]),
    ) ||
    typeof value.truncation.spaces !== "boolean" ||
    typeof value.truncation.panes !== "boolean" ||
    !nonnegativeInteger(value.truncation.omittedSpaceCount) ||
    !nonnegativeInteger(value.truncation.omittedPaneCount) ||
    value.truncation.spaces !== (value.truncation.omittedSpaceCount > 0) ||
    value.truncation.panes !== (value.truncation.omittedPaneCount > 0) ||
    value.complete !==
      (value.truncation.omittedSpaceCount === 0 &&
        value.truncation.omittedPaneCount === 0)
  ) {
    return null;
  }
  const spaces = [];
  let totalPanes = 0;
  const ids = new Set();
  for (const space of value.spaces) {
    if (
      !exactKeys(
        space,
        new Set(["id", "name", "kind", "windowLabel", "panes"]),
      ) ||
      !boundedString(space.id) ||
      ids.has(space.id) ||
      !boundedString(space.name, MAX_LABEL_LENGTH) ||
      !["desktop", "popout"].includes(space.kind) ||
      !WINDOW_LABEL.test(space.windowLabel ?? "") ||
      !Array.isArray(space.panes) ||
      space.panes.length > MAX_SPACE_QUERY_PANES_PER_SPACE
    ) {
      return null;
    }
    ids.add(space.id);
    const panes = space.panes.map((pane) => parsePane(pane, value.schemaVersion));
    if (panes.some((pane) => pane === null)) return null;
    totalPanes += panes.length;
    if (totalPanes > MAX_SPACE_QUERY_TOTAL_PANES) return null;
    spaces.push({ ...space, panes });
  }
  return { ...value, spaces };
}

/** Select a unique current Agent view from a complete parsed snapshot. */
export function findAgentPane(presentation, agentId) {
  if (!presentation?.complete || !agentId) return null;
  const matches = presentation.spaces.flatMap((space) =>
    space.panes.filter(
      (pane) => pane.component === "agent" && pane.agentId === agentId,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}
