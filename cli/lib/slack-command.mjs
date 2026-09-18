import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SlackApi } from "./slack/api.mjs";
import { DureSlackBackend } from "./slack/backend.mjs";
import { SlackBridge } from "./slack/bridge.mjs";
import { SLACK_APP_MANIFEST, validateSlackConfig } from "./slack/event.mjs";
import { SlackJournal } from "./slack/journal.mjs";
import { runSlackSocket } from "./slack/socket.mjs";
import { requestSlackShare, requestSlackStatus, serveSlackControl } from "./slack/control.mjs";
import { SlackShares } from "./slack/share.mjs";
import { SlackPoller } from "./slack/poll.mjs";
import { SlackFiles } from "./slack/files.mjs";

export const SLACK_HELP = `Dure · Slack connector

  dure slack manifest
  dure slack serve --config FILE [--backend ID] [--owner-lifetime stdin]
  dure slack status --config FILE
  dure slack share --config FILE --agent ID --channel ID [--backend ID]

Create a Slack app from the manifest and install it in your workspace. Create an
app-level token with connections:write. Set DURE_SLACK_APP_TOKEN and
DURE_SLACK_BOT_TOKEN locally; do not put tokens in the configuration file.
File attachments require files:read and files:write. After adding these scopes,
reinstall the Slack app in the workspace and update its bot token in Connections.

Configuration:
  {"schemaVersion":1,"teamId":"T...","channels":[
    {"channelId":"C...","projectId":"project-...","providerId":"claude","backend":"team-server"}
  ]}

Connect an invited channel or a bot DM to a registered Dure project. Mention
@Dure to start or continue, including inside a task thread. Untagged thread
messages in linked tasks are saved as context for the next mention without
starting or steering work. Bot DMs do not require a mention.
An optional objective on a channel supplies shared context. Each new thread
uses its own worktree. Dure and Slack share the same agent conversation.
Start the connector in a Dure terminal to open tasks in that Space, or set
an optional space on a channel route to select another Space by name or ID.
An optional backend selects an existing local or SSH backend profile for new
threads in that channel; --backend supplies the default. One connector serves
the workspace's shared @Dure across these servers. Replies keep the original
task's server even after a channel's default changes.
Use share to connect an existing Dure task to a new Slack thread while the
connector is running. Only subsequent conversation updates are shared.
Specify the task's backend when it differs from the channel's default.
Provider questions appear in the task thread. Any teammate can use their
answer controls; mention @Dure to send further directions to the agent.

The connector stays active while this command runs. Ctrl-C disconnects Slack;
existing work and conversations remain in Dure. A service can pass
--owner-lifetime stdin and keep its stdin pipe open; closing that pipe stops
the connector. Status reads the live connection when available, without
claiming that a journal lock proves connectivity. Node.js 22+ is required.`;

export function parseSlackCommand(args) {
  const [action, ...rest] = args;
  if (!action || ["--help", "-h", "help"].includes(action)) return { action: "help" };
  if (action === "manifest" && rest.length === 0) return { action };
  if (!["serve", "status", "share"].includes(action)) throw new Error(SLACK_HELP);
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const allowed = action === "share" ? ["--config", "--backend", "--agent", "--channel", "--request-id"] : action === "serve" ? ["--config", "--backend", "--owner-lifetime"] : ["--config", "--backend"];
    if (!allowed.includes(key) || !rest[index + 1] || options[key]) throw new Error(SLACK_HELP);
    options[key] = rest[index + 1];
  }
  if (!options["--config"]) throw new Error(SLACK_HELP);
  if (action === "share" && (!options["--agent"] || !options["--channel"])) throw new Error(SLACK_HELP);
  if (options["--owner-lifetime"] !== undefined && options["--owner-lifetime"] !== "stdin") throw new Error(SLACK_HELP);
  return { action, ownerLifetime: options["--owner-lifetime"], config: path.resolve(options["--config"]), backend: options["--backend"],
    agentId: options["--agent"], channelId: options["--channel"], requestId: options["--request-id"] };
}

function journalSummary(state) {
  return { threads: Object.keys(state?.threads ?? {}).length,
    queued: Object.values(state?.inbox ?? {}).filter((entry) => entry.state === "queued").length,
    failed: Object.values(state?.inbox ?? {}).filter((entry) => entry.state === "failed").length +
      Object.values(state?.outbound ?? {}).filter((entry) => entry.failed).length +
      Object.values(state?.files ?? {}).filter((entry) => ["failed", "sending"].includes(entry.state)).length +
      Object.values(state?.shares ?? {}).filter((entry) => entry.state === "failed").length };
}

export async function runSlackCommand(args, { resolveBackend, presentRun, environment = process.env,
  output = (text) => process.stdout.write(text), signal: ownerSignal, input = process.stdin,
  fetchApi = fetch, WebSocketImpl = globalThis.WebSocket }) {
  const command = parseSlackCommand(args);
  if (command.action === "help") return output(`${SLACK_HELP}\n`);
  if (command.action === "manifest") return output(`${JSON.stringify(SLACK_APP_MANIFEST, null, 2)}\n`);
  const config = validateSlackConfig(JSON.parse(fs.readFileSync(command.config, "utf8")));
  const journalFile = `${command.config}.deliveries.json`;
  const controlFile = `${command.config}.connector.json`;
  if (command.action === "share") {
    const result = await requestSlackShare(controlFile, { schemaVersion: 1, teamId: config.teamId,
      agentId: command.agentId, channelId: command.channelId, backend: command.backend,
      requestId: command.requestId ?? randomUUID() });
    return output(`${JSON.stringify(result)}\n`);
  }
  if (command.action === "status") {
    let status;
    try { status = await requestSlackStatus(controlFile, config.teamId); }
    catch {
      const state = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, "utf8")) : null;
      status = { schemaVersion: 1, teamId: config.teamId, ...journalSummary(state), connection: "unavailable" };
    }
    return output(`${JSON.stringify({ ...status, connectorLockPresent: fs.existsSync(`${journalFile}.lock`) })}\n`);
  }
  const appToken = environment.DURE_SLACK_APP_TOKEN;
  const botToken = environment.DURE_SLACK_BOT_TOKEN;
  // Keep connector credentials out of subsequently launched backend/provider
  // processes. They are used only by this process's Slack transport.
  delete environment.DURE_SLACK_APP_TOKEN;
  delete environment.DURE_SLACK_BOT_TOKEN;
  const controller = new AbortController();
  const { signal } = controller;
  let connection = "connecting";
  let journal;
  let control;
  let failure;
  const report = (event, extra = {}) => output(`${JSON.stringify({ event, teamId: config.teamId, ...extra })}\n`);
  const stop = () => controller.abort();
  const observeConnection = (state) => {
    if (signal.aborted || connection === state) return;
    connection = state;
    report(`slack.${state}`);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  ownerSignal?.addEventListener("abort", stop, { once: true });
  if (ownerSignal?.aborted) stop();
  if (command.ownerLifetime === "stdin") {
    input.once("end", stop);
    input.once("close", stop);
    input.once("error", stop);
    input.resume();
    if (input.readableEnded || input.destroyed) stop();
  }
  // Log only controlled errors. Network exceptions can include signed socket
  // URLs or headers, so their raw messages must never reach the terminal.
  const errorCode = (error) => /^[a-z_]{1,80}$/.test(error?.code ?? "") ? error.code : "slack_delivery_failed";
  const onError = (error, messageId) => report("slack.delivery_failed", { code: errorCode(error), messageId });
  try {
    if (signal.aborted) return;
    report("slack.connecting");
    const backend = new DureSlackBackend(resolveBackend, {
      defaultBackend: command.backend, signal, presentRun,
      onPresentationError: (_error, agentId) => report("slack.dure_view_failed", { agentId }),
    });
    let filePermissions = null;
    const observePermissions = (permissions) => {
      if (signal.aborted || JSON.stringify(permissions) === JSON.stringify(filePermissions)) return;
      filePermissions = permissions;
      report("slack.file_permissions", { permissions });
    };
    const slack = new SlackApi({ appToken, botToken, signal, fetchApi, onFilePermissions: observePermissions });
    const auth = await slack.call("auth.test");
    signal.throwIfAborted();
    if (auth.team_id !== config.teamId || !auth.bot_id || !auth.user_id) throw new Error("The Slack bot token does not match the configured workspace.");
    slack.botUserId = auth.user_id;
    journal = new SlackJournal(journalFile, config);
    await journal.acquire(() => backend.bind({}));
    signal.throwIfAborted();
    const files = new SlackFiles({ journal, backend, slack });
    const bridge = new SlackBridge({ config, botUserId: auth.user_id, journal, backend, slack, files });
    const sharing = new SlackShares({ config, journal, backend, slack });
    control = await serveSlackControl({ file: controlFile, teamId: config.teamId,
      share: (request) => sharing.share(request),
      status: () => ({ ...journalSummary(journal.data), connection: signal.aborted ? "stopping" : connection, filePermissions }),
    });
    signal.throwIfAborted();
    let nextPermissionCheck = Date.now() + 60_000;
    const pollPermissions = async (failed) => {
      if (Date.now() < nextPermissionCheck) return;
      nextPermissionCheck = Date.now() + 60_000;
      try { await slack.call("auth.test"); }
      catch (error) { observePermissions(null); failed(error); }
    };
    const poller = new SlackPoller({ signal, onError,
      polls: () => [...bridge.polls(), ...sharing.polls(), ["file-permissions", pollPermissions]],
    });
    const work = [runSlackSocket({ slack, bridge, signal,
      onConnecting: () => observeConnection("connecting"),
      onConnected: () => observeConnection("connected"),
      onDisconnected: () => observeConnection("disconnected"),
      onError, WebSocketImpl,
    }), poller.run()];
    try { await Promise.all(work); }
    finally { controller.abort(); await Promise.allSettled(work); await poller.settle(); }
  } catch (error) {
    if (error?.name !== "AbortError") { failure = error; throw error; }
  } finally {
    controller.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    ownerSignal?.removeEventListener("abort", stop);
    if (command.ownerLifetime === "stdin") {
      input.removeListener("end", stop);
      input.removeListener("close", stop);
      input.removeListener("error", stop);
      input.pause();
    }
    try { await control?.close(); }
    finally { journal?.close(); }
    report(failure ? "slack.failed" : "slack.stopped", failure ? { code: errorCode(failure) } : {});
  }
}
