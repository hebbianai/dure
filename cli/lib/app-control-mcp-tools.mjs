import { appControlDirectory, loadAppControlDescriptor } from "./app-control-location.mjs";
import {
  clientPresentationErrorReport,
  clientPresentationExitCode,
  clientPresentationRequestedCommand,
  runClientPresentationCommand,
} from "./client-presentation-command.mjs";

const id = { type: "string", minLength: 1, maxLength: 512 };
const operations = {
  app_space_show: {
    description: "Select one exact Space in its owning Dure window. Discover spaceId with app_observe. Changes the selected Space without OS foreground focus; creates no panes, sessions or devices. For a hidden mobile pane, show its Space, then inspect preview readiness before input.",
    properties: { spaceId: id }, required: ["spaceId"], args: ({ spaceId }) => ["space", "show", spaceId],
  },
  app_project_add: {
    description: "Register a folder in the connected app's shared project list using the GUI registration owner. Space (ID or unique name) or spaceId selects request context, not project ownership; omission uses the known invoking pane's Space or app default. Local path defaults to CLI cwd; SSH requires an explicit path and registered app hostId. Returns the canonical persisted project; creates no pane, process or worktree. Existing GUI folder trust behavior applies. Independent of backend projects.register and DURE_BACKEND_PROFILE.",
    properties: { path: { type: "string", maxLength: 4096 }, space: id, spaceId: id, hostId: id }, required: [],
    args: ({ path, space, spaceId, hostId }) => ["project", "add", ...(path !== undefined ? [path] : []),
      ...(space !== undefined ? ["--space", space] : []),
      ...(spaceId !== undefined ? ["--space-id", spaceId] : []),
      ...(hostId !== undefined ? ["--host", hostId] : [])],
  },
  app_observe: {
    description: "Discover Dure Spaces, windows and exact pane IDs from the saved client projection, with its age. Follow with app_pane_state for current mounted actions.",
    properties: {}, required: [], args: () => ["observe"], readOnly: true,
  },
  app_pane_state: {
    description: "Read one mounted Dure pane: status, diagnostics, available actions, parameter choices, current settings and disabled reasons. Use exact pane IDs from app_observe.",
    properties: { paneId: id }, required: ["paneId"],
    args: ({ paneId }) => ["pane", "state", paneId], readOnly: true,
  },
  app_pane_act: {
    description: "Invoke the same handler as the pane UI. Discover the action with app_pane_state first. Declared actions return applied/unchanged/pending/refused/failed; legacy invoked does not prove success. Reuse the same idempotency key only for retries of the identical request in the same app generation.",
    properties: {
      paneId: id, actionId: id,
      arguments: { type: "object", description: "Arguments described by this pane's actionDefinitions." },
      idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9_.-]{1,128}$" },
    },
    required: ["paneId", "actionId", "idempotencyKey"],
    destructive: true,
    args: ({ paneId, actionId, arguments: input = {}, idempotencyKey }) => [
      "pane", "act", paneId, actionId, "--args-json", JSON.stringify(input), "--idempotency-key", idempotencyKey,
    ],
  },
  app_workspace_open: {
    description: "Open the exact pane workspace in an external editor using the same transaction as Dure's Open in menu.",
    properties: { paneId: id, spaceId: id, targetId: id }, required: ["paneId", "spaceId"],
    args: ({ paneId, spaceId, targetId }) => ["workspace", "open", paneId, "--space-id", spaceId, ...(targetId !== undefined ? ["--target", targetId] : [])],
  },
  app_pane_split: {
    description: "Split beside an exact session through Dure's existing pane creation transaction.",
    properties: { sessionId: id, referencePaneId: id, direction: { type: "string", enum: ["below", "right"] }, cwd: { type: "string", maxLength: 4096 } },
    required: ["sessionId"],
    args: ({ sessionId, referencePaneId, direction, cwd }) => ["pane", "split", sessionId,
      ...(referencePaneId !== undefined ? ["--reference-panel-id", referencePaneId] : []),
      ...(direction !== undefined ? ["--direction", direction] : []), ...(cwd !== undefined ? ["--cwd", cwd] : [])],
  },
  app_pane_open: {
    description: "Open or focus the mobile simulator tool in an explicit Space, preserving its selection and saved profiles. Reuses an existing mobile pane. Use the returned panelId with app_pane_state to discover device selection, preview, profile and report actions.",
    properties: { tool: { type: "string", enum: ["mobile"] }, space: id, spaceId: id }, required: ["tool"],
    args: ({ tool, space, spaceId }) => ["pane", "open", tool,
      ...(space !== undefined ? ["--space", space] : []),
      ...(spaceId !== undefined ? ["--space-id", spaceId] : [])],
  },
  app_pane_create: {
    description: "Create a terminal through the connected app's existing local or registered SSH creation transaction, independently of the runtime backend profile. Choose space (ID or unique name) or spaceId (exact ID without a saved projection); omission uses the invoking pane's Space when known, otherwise the app's active Space. No worktree is created. Local receipts prove attachment; SSH receipts prove durable mount. An uncertain response must not be blindly retried.",
    properties: { space: id, spaceId: id, hostId: id, cwd: { type: "string", maxLength: 4096 } }, required: [],
    args: ({ space, spaceId, hostId, cwd }) => ["pane", "create",
      ...(space !== undefined ? ["--space", space] : []),
      ...(spaceId !== undefined ? ["--space-id", spaceId] : []),
      ...(hostId !== undefined ? ["--host", hostId] : []),
      ...(cwd !== undefined ? ["--cwd", cwd] : [])],
  },
  app_pane_close: {
    description: "Close one exact pane using Dure's existing close transaction. Requires explicit confirmation.",
    properties: { paneId: id, spaceId: id, confirm: { type: "boolean", const: true } }, required: ["paneId", "spaceId", "confirm"],
    args: ({ paneId, spaceId, confirm }) => ["pane", "close", paneId, "--space-id", spaceId, ...(confirm ? ["--yes"] : [])],
    destructive: true,
  },
};

export const appControlMcpTools = Object.entries(operations).map(([name, operation]) => ({
  name, description: operation.description,
  inputSchema: { type: "object", properties: operation.properties, required: operation.required, additionalProperties: false },
  annotations: { readOnlyHint: operation.readOnly === true, destructiveHint: operation.destructive === true, openWorldHint: false },
}));

function validInput(input, operation) {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    && operation.required.every((key) => Object.hasOwn(input, key))
    && Object.entries(input).every(([key, value]) => {
      const schema = operation.properties[key];
      return schema && typeof value === schema.type && value !== null && !Array.isArray(value)
        && (schema.const === undefined || value === schema.const)
        && (!schema.enum || schema.enum.includes(value));
    });
}

/** Transport adaptation only: argument parsing, HTTP and receipt formatting are
 * shared with the CLI; execution and state remain in the mounted UI/domain. */
export async function callAppControlMcpTool(name, input, environment, dependencies = {}) {
  if (!Object.hasOwn(operations, name)) return undefined;
  let receipt;
  let request;
  try {
    const operation = operations[name];
    if (!validInput(input, operation)) throw Object.assign(new Error("Invalid Dure app tool arguments."), { code: "invalid_request" });
    const directory = dependencies.appControlDirectory ?? appControlDirectory(environment);
    const args = operation.args(input);
    request = clientPresentationRequestedCommand(args);
    receipt = await runClientPresentationCommand(args, {
      directory,
      environment,
      descriptor: dependencies.appControlDescriptor ?? loadAppControlDescriptor(directory),
      fetchImpl: dependencies.appControlFetch,
    });
  } catch (error) {
    receipt = clientPresentationErrorReport(error, request);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(receipt) }],
    structuredContent: receipt,
    isError: Boolean(receipt.error) || clientPresentationExitCode(receipt) !== 0,
  };
}
