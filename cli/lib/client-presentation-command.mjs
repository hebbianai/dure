import {
  AppControlClientError,
  publicAppControlIdentity,
  requestAppControl,
} from "./app-control-client.mjs";
import { observeApp } from "./app-observation.mjs";
import { join, resolve } from "node:path";
import { loadSessionClientProjection } from "./client-registry.mjs";
import { resolveClientSpaceTarget } from "./space-selection.mjs";

const PANE_API_VERSION = "dure.client-pane/v1";
const PRESENTATION_API_VERSION = "dure.client-presentation/v1";
const MAX_ID_CHARACTERS = 512;
const MAX_SPACE_NAME_CHARACTERS = 256;
const MAX_PATH_CHARACTERS = 4096;
const HELP_ARGUMENTS = new Set(["help", "-h", "--help"]);

export const CLIENT_PRESENTATION_HELP = `dure client — connected Dure client presentation control

Usage:
  dure client observe [--json]
  dure client space create [--name NAME] [--json]
  dure client space show <space-id> [--json]
  dure client unopened get <agent-id> [--json]
  dure client unopened hide|restore <agent-id> --expected-episode N [--json]
  dure client project add [PATH] [--space ID_OR_NAME | --space-id ID]
                         [--host local|SSH_HOST_ID] [--json]
  dure client host add <SSH_CONFIG_ALIAS> [--name NAME] [--json]
  dure client host add --hostname HOST --user USER [--port PORT]
                       [--identity-file PATH] [--name NAME] [--json]
  dure client pane open mobile (--space ID_OR_NAME | --space-id ID) [--json]
  dure client pane create [--space ID_OR_NAME | --space-id ID]
                          [--cwd PATH] [--host local|SSH_HOST_ID] [--json]
  dure client pane split <reference-session-id> [--reference-panel-id ID]
                         [--direction below|right] [--cwd PATH] [--json]
  dure client pane close <panel-id> --space-id ID --yes [--json]
  dure client pane state <panel-id> [--json]
  dure client pane act <panel-id> <action-id> [--args-json OBJECT]
                      [--idempotency-key KEY] [--json]
  dure client workspace open <panel-id> --space-id ID [--target TARGET] [--json]

Commands call the connected app's existing presentation transactions.
Space create adds and selects a new Space; omit --name to use the app's default name.
It returns space.spaceId after the Space mounts. Inspect client observe before retrying an uncertain creation.
Space show selects that exact Space in its owning Dure window without creating panes or devices.
Discover IDs with client observe. This changes the selected Space, not OS foreground focus.
Unopened visibility changes only Hide from list, never sessions or worktrees.
Use the exact registered agent ID and the episode returned by get; newer activity resurfaces it.
After an uncertain response, get its current visibility before requesting another change.
Project add registers a shared app location; Space is request context, not ownership.
It creates no pane/session/worktree. Local PATH defaults to CLI cwd; SSH PATH is required.
Existing GUI folder inspection, canonical repository identity and trust behavior apply.
This is separate from backend-only dure projects register.
Host add uses the app's durable SSH registration; the returned host.id works with --host.
An alias imports ~/.ssh/config. Explicit destinations use a key file or normal SSH authentication.
Registration creates no session. The first terminal open installs Hmux if it is missing.
Open mobile reuses the mobile simulator pane in the explicitly selected Space.
Use its returned panelId with pane state to discover device, profile, preview and report actions.
Pane create uses the invoking pane's Space when known, otherwise the app's active Space.
Local cwd defaults to the CLI working directory; SSH cwd defaults to the remote home.
No Git worktree is created. --host selects a registered app SSH host, not a backend profile.
Client presentation uses the connected app, independently of DURE_BACKEND_PROFILE.
Local creation reports native attachment; SSH creation reports durable pane mount.
An uncertain response is not permission to create again; inspect the app first.
Use pane state/act for the mounted pane's actions (including terminal.input).
When Chat offers resend_last_message, pane act invokes the same retained-message recovery as its button.
Inspect pane state first; reuse the same --idempotency-key after an uncertain action response.
Only an explicit error.execution=not_started refusal permits a new key after the stated recovery.
For pane_not_found, reopen the existing pane and confirm pane state first; the previous key keeps its refusal.
Use a fresh key for each new status observation; reusing a key replays the earlier observation.
Workspace open uses the last successful target when --target is omitted.
Without a connected app, the result is client_unavailable.`;

export class ClientPresentationCommandError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ClientPresentationCommandError";
    this.code = code;
  }
}

function invalidRequest(message) {
  return new ClientPresentationCommandError("invalid_request", message);
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function boundedIdentity(value, label, maxCharacters = MAX_ID_CHARACTERS) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw invalidRequest(`${label} is required.`);
  if (
    normalized.length > maxCharacters ||
    containsControlCharacter(normalized)
  ) {
    throw invalidRequest(`${label} is invalid.`);
  }
  return normalized;
}

function boundedPath(value) {
  const path = typeof value === "string" ? value : "";
  if (
    !path ||
    path.length > MAX_PATH_CHARACTERS ||
    containsControlCharacter(path)
  ) {
    throw invalidRequest("cwd is invalid.");
  }
  return path;
}

export function clientSpaceIdentityPayload({ spaceId, desktopId }) {
  const canonical = typeof spaceId === "string" ? spaceId.trim() : "";
  const legacy = typeof desktopId === "string" ? desktopId.trim() : "";
  if (canonical && legacy && canonical !== legacy) {
    throw new ClientPresentationCommandError(
      "client_space_identity_conflict",
      "--space-id and the deprecated --desktop-id must refer to the same Space.",
    );
  }
  const selected = canonical || legacy;
  if (!selected) return {};
  const identity = boundedIdentity(selected, "Space ID");
  return { spaceId: identity, desktopId: identity };
}

const PANE_ACTIONS = new Set(["open", "create", "split", "close", "state", "act"]);
const UNOPENED_ACTIONS = new Set(["get", "hide", "restore"]);

export function clientPresentationRequestedCommand(args) {
  if (!Array.isArray(args)) return null;
  if (args[0] === "observe") return { domain: "app", action: "observe" };
  if (args[0] === "space" && (args[1] === "show" || args[1] === "create")) return { domain: "space", action: args[1] };
  if (args[0] === "unopened" && UNOPENED_ACTIONS.has(args[1])) {
    return { domain: "unopened", action: args[1] };
  }
  if (args[0] === "pane" && PANE_ACTIONS.has(args[1])) {
    return { domain: "pane", action: args[1] };
  }
  if (args[0] === "workspace" && args[1] === "open") {
    return { domain: "workspace", action: "open" };
  }
  if (args[0] === "project" && args[1] === "add") {
    return { domain: "project", action: "add" };
  }
  if (args[0] === "host" && args[1] === "add") {
    return { domain: "host", action: "add" };
  }
  return null;
}

export function clientPresentationJsonRequested(args) {
  return Array.isArray(args) && args.includes("--json");
}

function readCommandTail(args, { values, flags, optionLabel, maxTargets = 1 }) {
  const options = {};
  const seen = new Set();
  const targets = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const valueKey = values.get(argument);
    const flagKey = flags.get(argument);
    const optionKey = valueKey ?? flagKey;
    if (optionKey) {
      if (seen.has(optionKey)) {
        throw invalidRequest(`${argument} may only be specified once.`);
      }
      seen.add(optionKey);
      if (valueKey) {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("-")) {
          throw invalidRequest(`${argument} requires a value.`);
        }
        options[valueKey] = value;
        index += 1;
      } else {
        options[flagKey] = true;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      throw invalidRequest(`Unsupported ${optionLabel} option: ${argument}`);
    }
    if (targets.length >= maxTargets) {
      throw invalidRequest(`Unexpected ${optionLabel} argument: ${argument}`);
    }
    targets.push(argument);
  }
  return { options, target: targets[0], targets };
}

function parseUnopenedCommand(action, tail) {
  const { target, options } = readCommandTail(tail, {
    values: new Map(action === "get" ? [] : [["--expected-episode", "expectedEpisode"]]),
    flags: new Map([["--json", "json"]]),
    optionLabel: "client unopened",
  });
  const expectedEpisode = Number(options.expectedEpisode);
  if (action !== "get" && (!/^\d+$/.test(options.expectedEpisode ?? "") || !Number.isSafeInteger(expectedEpisode))) {
    throw invalidRequest("--expected-episode requires the non-negative integer returned by unopened get.");
  }
  return {
    domain: "unopened", action, path: "/agents/unopened/visibility",
    body: { schemaVersion: 1, operation: action, agentId: boundedIdentity(target, "agent ID"),
      ...(action === "get" ? {} : { expectedEpisode }) },
  };
}

function parsePaneStateCommand(tail) {
  const { target } = readCommandTail(tail, {
    values: new Map(),
    flags: new Map([["--json", "json"]]),
    optionLabel: "client pane",
  });
  return {
    domain: "pane",
    action: "state",
    path: "/pane/state",
    body: { targetPanelId: boundedIdentity(target, "pane ID") },
  };
}

function locationSelection(options) {
  if (options.space !== undefined && options.spaceId !== undefined) {
    throw invalidRequest("Choose --space or --space-id, not both.");
  }
  const hostId = options.hostId === undefined ? "local" : boundedIdentity(options.hostId, "Host ID");
  return {
    ...(options.space !== undefined ? { spaceSelector: boundedIdentity(options.space, "Space") } : {}),
    body: {
      hostId,
      ...(options.spaceId !== undefined ? { spaceId: boundedIdentity(options.spaceId, "Space ID") } : {}),
    },
  };
}

function parsePaneOpenCommand(tail) {
  const { options, target } = readCommandTail(tail, {
    values: new Map([["--space", "space"], ["--space-id", "spaceId"]]),
    flags: new Map([["--json", "json"]]), optionLabel: "client pane open",
  });
  if (target !== "mobile") throw invalidRequest("Supported tool: mobile.");
  if (options.space === undefined && options.spaceId === undefined) throw invalidRequest("pane open requires --space or --space-id.");
  const selection = locationSelection(options);
  return { domain: "pane", action: "open", path: "/pane/open", ...selection,
    body: { tool: "mobile", ...(selection.body.spaceId ? { spaceId: selection.body.spaceId } : {}) } };
}

function parsePaneCreateCommand(tail) {
  const { options } = readCommandTail(tail, {
    values: new Map([["--space", "space"], ["--space-id", "spaceId"], ["--cwd", "cwd"], ["--host", "hostId"]]),
    flags: new Map([["--json", "json"]]), optionLabel: "client pane create", maxTargets: 0,
  });
  const selection = locationSelection(options);
  return {
    domain: "pane", action: "create", path: "/hmux/create", ...selection,
    body: { ...selection.body, ...(options.cwd !== undefined ? { cwd: boundedPath(options.cwd) } : {}) },
  };
}

function parseProjectAddCommand(tail) {
  const { options, target } = readCommandTail(tail, {
    values: new Map([["--space", "space"], ["--space-id", "spaceId"], ["--host", "hostId"]]),
    flags: new Map([["--json", "json"]]), optionLabel: "client project add",
  });
  const selection = locationSelection(options);
  if (selection.body.hostId !== "local" && target === undefined) {
    throw invalidRequest("An explicit PATH is required for an SSH project; local cwd is not a remote directory.");
  }
  return {
    domain: "project", action: "add", path: "/project/add", ...selection,
    body: { ...selection.body, ...(target !== undefined ? { path: boundedPath(target) } : {}) },
  };
}

function parseHostAddCommand(tail) {
  const { options, target } = readCommandTail(tail, {
    values: new Map([["--hostname", "host"], ["--user", "user"], ["--port", "port"],
      ["--identity-file", "keyPath"], ["--name", "name"]]),
    flags: new Map([["--json", "json"]]), optionLabel: "client host add",
  });
  const body = {};
  if (target !== undefined) {
    if (["host", "user", "port", "keyPath"].some((key) => options[key] !== undefined)) {
      throw invalidRequest("Choose an SSH config alias or explicit connection options, not both.");
    }
    body.sshConfigAlias = boundedIdentity(target, "SSH config alias");
  } else {
    body.host = boundedIdentity(options.host, "hostname");
    body.user = boundedIdentity(options.user, "user");
    if (options.port !== undefined) {
      if (!/^\d+$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) {
        throw invalidRequest("port must be an integer from 1 to 65535.");
      }
      body.port = Number(options.port);
    }
    if (options.keyPath !== undefined) body.keyPath = boundedPath(options.keyPath);
  }
  if (options.name !== undefined) body.name = boundedIdentity(options.name, "name");
  return { domain: "host", action: "add", path: "/ssh/hosts/add", body };
}

function parsePaneActCommand(tail) {
  const { targets, options } = readCommandTail(tail, {
    values: new Map([["--args-json", "arguments"], ["--idempotency-key", "idempotencyKey"]]),
    flags: new Map([["--json", "json"]]),
    optionLabel: "client pane",
    maxTargets: 2,
  });
  let argumentsValue;
  if (options.arguments !== undefined) {
    try { argumentsValue = JSON.parse(options.arguments); }
    catch { throw invalidRequest("--args-json must contain a JSON object."); }
    if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
      throw invalidRequest("--args-json must contain a JSON object.");
    }
  }
  if (options.idempotencyKey !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(options.idempotencyKey)) {
    throw invalidRequest("--idempotency-key must be 1..128 ASCII letters, numbers, dots, underscores or hyphens.");
  }
  return {
    domain: "pane",
    action: "act",
    path: "/pane/act",
    body: {
      targetPanelId: boundedIdentity(targets[0], "pane ID"),
      actionId: boundedIdentity(targets[1], "action ID"),
      ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
    },
  };
}

function parsePaneCommand(action, tail) {
  const values =
    action === "split"
      ? new Map([
          ["--reference-panel-id", "referencePanelId"],
          ["--direction", "direction"],
          ["--cwd", "cwd"],
        ])
      : new Map([
          ["--space-id", "spaceId"],
          ["--desktop-id", "desktopId"],
        ]);
  const flags =
    action === "split"
      ? new Map([["--json", "json"]])
      : new Map([
          ["--json", "json"],
          ["--yes", "yes"],
          ["-y", "yes"],
        ]);
  const { options, target } = readCommandTail(tail, {
    values,
    flags,
    optionLabel: "client pane",
  });
  if (action === "split") {
    const direction = options.direction || "below";
    if (direction !== "below" && direction !== "right") {
      throw invalidRequest("--direction must be below or right.");
    }
    const body = {
      referenceSessionId: boundedIdentity(target, "reference Session ID"),
      direction,
    };
    if (options.referencePanelId !== undefined) {
      body.referencePanelId = boundedIdentity(
        options.referencePanelId,
        "reference pane ID",
      );
    }
    if (options.cwd !== undefined) body.cwd = boundedPath(options.cwd);
    return { domain: "pane", action, path: "/pane/create", body };
  }

  if (!options.yes) {
    throw new ClientPresentationCommandError(
      "confirmation_required",
      "client pane close is destructive. Specify --yes to execute it.",
    );
  }
  const spaceIdentity = clientSpaceIdentityPayload(options);
  if (!spaceIdentity.spaceId) {
    throw invalidRequest("client pane close requires --space-id.");
  }
  return {
    domain: "pane",
    action,
    path: "/pane/close",
    body: {
      targetPanelId: boundedIdentity(target, "pane ID"),
      ...spaceIdentity,
      confirm: true,
    },
  };
}

function parseWorkspaceCommand(action, tail) {
  if (action !== "open") throw invalidRequest(CLIENT_PRESENTATION_HELP);
  const { options, target } = readCommandTail(tail, {
    values: new Map([
      ["--space-id", "spaceId"],
      ["--desktop-id", "desktopId"],
      ["--target", "targetId"],
    ]),
    flags: new Map([["--json", "json"]]),
    optionLabel: "client workspace",
  });
  const spaceIdentity = clientSpaceIdentityPayload(options);
  if (!spaceIdentity.spaceId) {
    throw invalidRequest("client workspace open requires --space-id.");
  }
  const body = {
    panelId: boundedIdentity(target, "pane ID"),
    ...spaceIdentity,
  };
  if (options.targetId !== undefined) {
    body.targetId = boundedIdentity(options.targetId, "external target ID");
  }
  return {
    domain: "workspace",
    action,
    path: "/workspace/open-external",
    body,
  };
}

export function parseClientPresentationCommand(args) {
  const tokens = Array.isArray(args) ? args : [];
  const [domain, action, ...tail] = tokens;
  if (domain === "observe") {
    if (action === "--help" || action === "-h") return { help: true };
    readCommandTail(tokens.slice(1), { values: new Map(), flags: new Map([["--json", "json"]]), optionLabel: "client observe", maxTargets: 0 });
    return { help: false, domain: "app", action: "observe" };
  }
  if (
    !domain ||
    HELP_ARGUMENTS.has(domain) ||
    ((domain === "pane" || domain === "space" || domain === "workspace" || domain === "project" || domain === "host" || domain === "unopened") &&
      (!action ||
        HELP_ARGUMENTS.has(action) ||
        tail.some((value) => value === "-h" || value === "--help")))
  ) {
    return { help: true };
  }
  if (domain === "space" && action === "create") {
    const { options } = readCommandTail(tail, {
      values: new Map([["--name", "name"]]), flags: new Map([["--json", "json"]]),
      optionLabel: "client space create", maxTargets: 0,
    });
    return { help: false, domain, action, path: "/space/create",
      body: options.name === undefined ? {} : { name: boundedIdentity(options.name, "Space name", MAX_SPACE_NAME_CHARACTERS) } };
  }
  if (domain === "space" && action === "show") {
    const { target } = readCommandTail(tail, { values: new Map(), flags: new Map([["--json", "json"]]), optionLabel: "client space show" });
    return { help: false, domain, action, path: "/space/activate", body: { spaceId: boundedIdentity(target, "Space ID") } };
  }
  if (domain === "unopened" && UNOPENED_ACTIONS.has(action)) {
    return { help: false, ...parseUnopenedCommand(action, tail) };
  }
  if (domain === "pane" && (action === "split" || action === "close")) {
    return { help: false, ...parsePaneCommand(action, tail) };
  }
  if (domain === "project" && action === "add") {
    return { help: false, ...parseProjectAddCommand(tail) };
  }
  if (domain === "host" && action === "add") {
    return { help: false, ...parseHostAddCommand(tail) };
  }
  if (domain === "pane" && action === "open") {
    return { help: false, ...parsePaneOpenCommand(tail) };
  }
  if (domain === "pane" && action === "create") {
    return { help: false, ...parsePaneCreateCommand(tail) };
  }
  if (domain === "pane" && action === "state") {
    return { help: false, ...parsePaneStateCommand(tail) };
  }
  if (domain === "pane" && action === "act") {
    return { help: false, ...parsePaneActCommand(tail) };
  }
  if (domain === "workspace" && action === "open") {
    return { help: false, ...parseWorkspaceCommand(action, tail) };
  }
  throw invalidRequest(CLIENT_PRESENTATION_HELP);
}

function clientIdentity(descriptor) {
  return {
    channel: null, generation: null, buildId: null,
    ...publicAppControlIdentity(descriptor),
  };
}

function responseMember(payload, command) {
  if (command.domain === "space") return payload.space;
  if (command.domain === "unopened") return payload.visibility;
  if (command.domain === "project" || command.domain === "host") return payload.registration;
  if (command.domain === "workspace") return payload.workspace;
  return command.action === "close" ? payload.closed : payload.pane;
}

export async function runClientPresentationCommand(
  args,
  { descriptor, directory, environment = process.env, fetchImpl = globalThis.fetch } = {},
) {
  const command = parseClientPresentationCommand(args);
  if (command.help) return command;
  if (command.action === "observe") return observeApp({ directory, descriptor, fetchImpl });
  if (descriptor && command.domain === "host"
    && !(Array.isArray(descriptor.capabilities) && descriptor.capabilities.includes("ssh_hosts.add_v1"))) {
    throw new AppControlClientError("client_capability_missing", "Update the running Dure app; ssh_hosts.add_v1 is required.");
  }
  if (command.domain === "host" && command.body.keyPath !== undefined
    && !command.body.keyPath.startsWith("~/")) {
    command.body.keyPath = resolve(command.body.keyPath);
  }
  if (descriptor && command.domain === "unopened"
    && !(Array.isArray(descriptor.capabilities) && descriptor.capabilities.includes("unopened_agents.visibility_v1"))) {
    throw new AppControlClientError("client_capability_missing", "Update the running Dure app; unopened_agents.visibility_v1 is required.");
  }
  if ((command.domain === "pane" && (command.action === "create" || command.action === "open")) || command.domain === "project") {
    const capability = command.domain === "project" ? "project_registration.add_v1" : command.action === "open" ? "mobile_pane.open_v1" : "terminal_pane.create_v1";
    if (descriptor && !(Array.isArray(descriptor.capabilities) && descriptor.capabilities.includes(capability))) {
      throw new AppControlClientError("client_capability_missing", `Update the running Dure app; ${capability} is required.`);
    }
    if (command.body.spaceId === undefined && descriptor) {
      const target = resolveClientSpaceTarget({
        spaceSelector: command.spaceSelector, environment,
        registry: directory ? loadSessionClientProjection({ registryPath: join(directory, "agents.json") }) : undefined,
      });
      if (target.state === "requested") command.body.spaceId = target.spaceId;
    }
    if (command.body.hostId === "local") {
      const field = command.domain === "project" ? "path" : "cwd";
      command.body[field] = resolve(command.body[field] ?? process.cwd());
    }
  }
  if (descriptor && command.action === "act" && (command.body.arguments !== undefined || command.body.idempotencyKey !== undefined)
    && !(Array.isArray(descriptor?.capabilities) && descriptor.capabilities.includes("pane_actions.arguments_results_v1"))) {
    throw new AppControlClientError("client_capability_missing", "Update the running Dure app before using parameterized or replayable pane actions.");
  }
  const payload = await requestAppControl({
    descriptor,
    path: command.path,
    body: command.body,
    fetchImpl,
  });
  const member = responseMember(payload, command);
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    throw new AppControlClientError(
      "client_response_invalid",
      "Dure client presentation receipt is invalid.",
    );
  }
  if (command.domain === "unopened") {
    if (member.schemaVersion !== 1 || member.agentId !== command.body.agentId
      || !["unopened", "placed", "hidden_pane"].includes(member.placement)
      || !Number.isSafeInteger(member.episode) || member.episode < 0
      || typeof member.hidden !== "boolean" || typeof member.changed !== "boolean" || member.persisted !== true) {
      throw new AppControlClientError("client_response_invalid", "Dure unopened visibility receipt is invalid; inspect the app before another change.");
    }
    return {
      schemaVersion: 1, apiVersion: PRESENTATION_API_VERSION,
      kind: "dure.client_unopened.visibility", action: command.action,
      client: clientIdentity(descriptor), visibility: member,
    };
  }
  if (command.domain === "space") {
    if (command.action === "create") {
      const spaceId = humanReceiptIdentity(member.spaceId);
      const name = humanReceiptIdentity(member.name);
      if (!spaceId || spaceId !== spaceId.trim() || !name || name !== name.trim()
        || name.length > MAX_SPACE_NAME_CHARACTERS || member.mounted !== true
        || (member.desktopId !== undefined && member.desktopId !== spaceId)
        || (command.body.name !== undefined && name !== command.body.name)) {
        throw new AppControlClientError("client_response_invalid", "Space creation was not confirmed; inspect client observe before creating again.");
      }
    } else if (member.spaceId !== command.body.spaceId || member.active !== true) {
      throw new AppControlClientError("client_response_invalid", "The requested Space was not confirmed active; inspect client observe.");
    }
    return { schemaVersion: 1, apiVersion: PRESENTATION_API_VERSION, kind: `dure.client_space.${command.action}`,
      action: command.action, client: clientIdentity(descriptor), space: member };
  }
  if (command.domain === "project") {
    return {
      schemaVersion: 1, apiVersion: PRESENTATION_API_VERSION,
      kind: "dure.client_project.add", action: command.action,
      client: clientIdentity(descriptor), registration: member,
    };
  }
  if (command.domain === "host") {
    if (!humanReceiptIdentity(member.host?.id) || member.persisted !== true || typeof member.created !== "boolean") {
      throw new AppControlClientError("client_response_invalid", "Dure SSH host registration receipt is invalid; inspect the app before registering again.");
    }
    return {
      schemaVersion: 1, apiVersion: PRESENTATION_API_VERSION,
      kind: "dure.client_host.add", action: command.action,
      client: clientIdentity(descriptor), registration: member,
    };
  }
  if (command.domain === "workspace") {
    return {
      schemaVersion: 1,
      apiVersion: PRESENTATION_API_VERSION,
      kind: "dure.client_workspace.open",
      action: command.action,
      client: clientIdentity(descriptor),
      workspace: member,
    };
  }
  return {
    schemaVersion: 1,
    apiVersion: PANE_API_VERSION,
    kind: `dure.client_pane.${command.action}`,
    action: command.action,
    client: clientIdentity(descriptor),
    pane: member,
  };
}

export function clientPresentationErrorReport(error, request = null) {
  const workspace = request?.domain === "workspace";
  const app = request?.domain === "app";
  const project = request?.domain === "project";
  const host = request?.domain === "host";
  const unopened = request?.domain === "unopened";
  const space = request?.domain === "space";
  return {
    schemaVersion: 1,
    apiVersion: workspace || app || project || host || unopened || space ? PRESENTATION_API_VERSION : PANE_API_VERSION,
    kind: space ? "dure.client_space.error" : host ? "dure.client_host.error" : unopened ? "dure.client_unopened.error" : project ? "dure.client_project.error" : app ? "dure.client_observation.error" : workspace ? "dure.client_workspace.error" : "dure.client_pane.error",
    action: request?.action ?? null,
    error: {
      code:
        error && typeof error.code === "string"
          ? error.code
          : "client_presentation_failed",
      message: error instanceof Error ? error.message : String(error),
      ...(typeof error?.retryable === "boolean"
        ? { retryable: error.retryable }
        : {}),
      ...(typeof error?.nextAction === "string" && error.nextAction
        ? { nextAction: error.nextAction }
        : {}),
      ...(error?.execution === "not_started" ? { execution: "not_started" } : {}),
    },
  };
}

function humanReceiptIdentity(value) {
  return typeof value === "string" &&
    value.length <= MAX_ID_CHARACTERS &&
    !containsControlCharacter(value)
    ? value
    : null;
}

export function formatClientPresentationReceipt(report) {
  if (report.space) return `✓ Space ${report.action === "create" ? "created" : "selected"} → ${humanReceiptIdentity(report.space.spaceId) ?? "unknown"}`;
  if (report.registration?.host) {
    return `✓ SSH host ${report.registration.created ? "registered" : "already registered"} → ${humanReceiptIdentity(report.registration.host.id) ?? "unknown"}`;
  }
  if (report.visibility) {
    const { agentId, hidden, placement, episode } = report.visibility;
    return `✓ ${humanReceiptIdentity(agentId) ?? "agent"}: ${placement}, ${hidden ? "hidden from list" : "not hidden from list"} (episode ${episode})`;
  }
  if (report.registration) {
    const projectId = humanReceiptIdentity(report.registration.project?.id);
    return `✓ app project registered${projectId ? ` → ${projectId}` : ""}`;
  }
  if (report.kind === "dure.client_observation") {
    return JSON.stringify(report, null, 2);
  }
  if (report.workspace) {
    const spaceId = humanReceiptIdentity(
      report.workspace.spaceId ?? report.workspace.desktopId,
    );
    const panelId = humanReceiptIdentity(report.workspace.panelId);
    const targetId = humanReceiptIdentity(report.workspace.targetId);
    const identity = [spaceId, panelId].filter(Boolean).join("/");
    return `✓ workspace opened${identity ? ` → ${identity}` : ""}${
      targetId ? ` in ${targetId}` : ""
    }`;
  }
  if (report.action === "state") {
    const paneId = humanReceiptIdentity(report.pane.paneId);
    const status = humanReceiptIdentity(report.pane.status) ?? "unknown";
    const actions = Array.isArray(report.pane.actions)
      ? report.pane.actions.filter((value) => humanReceiptIdentity(value))
      : [];
    const errorText = humanReceiptIdentity(report.pane.error);
    return [
      `✓ ${paneId ?? "pane"}: ${status}`,
      errorText ? `  error: ${errorText}` : null,
      actions.length ? `  actions: ${actions.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (report.action === "act") {
    const paneId = humanReceiptIdentity(report.pane.paneId);
    const invoked = humanReceiptIdentity(report.pane.invoked);
    const outcome = report.pane.result?.outcome ?? "invoked";
    const failure = report.pane.result?.error;
    return `${clientPresentationExitCode(report) ? "✗" : "✓"} client pane action ${invoked ?? "?"} ${outcome}${
      paneId ? ` → ${paneId}` : ""
    }${failure ? `\n  ${failure.code}: ${failure.message}` : ""}`;
  }
  const spaceId = humanReceiptIdentity(
    report.pane.spaceId ?? report.pane.desktopId,
  );
  const panelId = humanReceiptIdentity(report.pane.panelId);
  const target = [spaceId, panelId].filter(Boolean).join("/");
  const detail = report.action === "create" ? "created" : report.action === "split" ? "split" : "closed";
  return `✓ client pane ${detail}${target ? ` → ${target}` : ""}`;
}

export function clientPresentationExitCode(report) {
  return ["refused", "failed"].includes(report.pane?.result?.outcome) ? 2 : 0;
}
