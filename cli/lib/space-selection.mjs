import { parseClientPresentation } from "./client-presentation-state.mjs";

// Selection consumes the already parsed presentation. Exact IDs remain usable
// in partial snapshots; names require a complete view to establish uniqueness.
export function selectSpace(presentation, rawSelector) {
  const selector = typeof rawSelector === "string" ? rawSelector.trim() : "";
  if (!selector || selector.length > 512 || /[\u0000-\u001f\u007f]/.test(selector)) {
    return { error: "selector_invalid" };
  }
  const exact = presentation.spaces.find((space) => space.id === selector);
  if (exact) return { space: exact };
  if (!presentation.complete) return { error: "projection_partial" };
  const named = presentation.spaces.filter((space) => space.name === selector);
  if (named.length === 0) return { error: "not_found" };
  if (named.length !== 1) return { error: "ambiguous" };
  return { space: named[0] };
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sourceIdentity(environment) {
  const sessionId = environment?.HMUX_SESSION_ID?.trim() || "";
  const workspaceId = environment?.HMUX_WORKSPACE_ID?.trim() || "";
  return sessionId && workspaceId ? { sessionId, workspaceId } : null;
}

function sourcePaneMatches(presentation, identity) {
  if (!identity) return [];
  return presentation.spaces.flatMap((space) =>
    space.panes.flatMap((pane) =>
      pane.binding?.sessionId === identity.sessionId &&
      pane.binding?.workspaceId === identity.workspaceId
        ? [
            {
              spaceId: space.id,
              windowLabel: space.windowLabel,
              panelId: pane.id,
            },
          ]
        : [],
    ),
  );
}

function explicitSpace(presentation, rawSelector) {
  const selected = selectSpace(presentation, rawSelector);
  if (selected.space) return selected.space;
  const messages = {
    selector_invalid: "The Space selector is invalid.",
    projection_partial: "Specify a Space ID when the client projection is incomplete.",
    not_found: "The requested Space was not found.",
    ambiguous: "More than one Space has this name. Specify its ID.",
  };
  fail(`client_space_${selected.error}`, messages[selected.error]);
}

function presentationAvailable(registry, presentation) {
  return (
    presentation !== null &&
    (registry?.state === "available" || registry?.state === "truncated")
  );
}

export function resolveClientSpaceTarget({
  spaceSelector,
  environment = process.env,
  registry,
} = {}) {
  const presentation = parseClientPresentation(registry?.clientPresentation);
  if (spaceSelector !== undefined) {
    if (!presentationAvailable(registry, presentation)) {
      fail(
        "client_space_projection_unavailable",
        "Could not read the connected Dure client's Space list.",
      );
    }
    const selected = explicitSpace(presentation, spaceSelector);
    const source = sourceIdentity(environment);
    const matches = presentation.complete
      ? sourcePaneMatches(presentation, source)
      : [];
    const selectedMatches = matches.filter(
      (match) => match.spaceId === selected.id,
    );
    const reference =
      selectedMatches.length === 1 ? selectedMatches[0].panelId : undefined;
    return {
      state: "requested",
      reason: "explicit_space",
      spaceId: selected.id,
      windowLabel: selected.windowLabel,
      ...(reference ? { referencePanelId: reference } : {}),
    };
  }

  const source = sourceIdentity(environment);
  if (!source) {
    return { state: "headless", reason: "source_pane_unavailable" };
  }
  if (
    presentation === null &&
    (registry?.state === "available" || registry?.state === "truncated")
  ) {
    fail(
      "client_source_projection_invalid",
      "The connected Dure client's pane projection does not match the current CLI contract.",
    );
  }
  if (!presentationAvailable(registry, presentation)) {
    return { state: "headless", reason: "source_pane_unavailable" };
  }
  if (!presentation.complete) {
    fail(
      "client_source_projection_partial",
      "Could not fully identify the current pane's Space. Specify --space <id>.",
    );
  }
  const matches = sourcePaneMatches(presentation, source);
  if (matches.length === 0) {
    return { state: "headless", reason: "source_pane_unavailable" };
  }
  if (matches.length !== 1) {
    fail(
      "client_source_pane_ambiguous",
      "The current Hmux session is open in multiple Spaces. Specify --space <id|name>.",
    );
  }
  return {
    state: "requested",
    reason: "invoking_pane",
    spaceId: matches[0].spaceId,
    windowLabel: matches[0].windowLabel,
    referencePanelId: matches[0].panelId,
  };
}
