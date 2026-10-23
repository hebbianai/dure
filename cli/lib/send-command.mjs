import { agentDisplayName } from "./client-registry.mjs";
import { readUtf8Input, readUtf8Stdin } from "./text-input.mjs";

const SEND_HELP = `dure send — Send text to an agent

Usage: dure send <name> <text...> [options]
       dure send <name> --file PATH [options]
       dure send <name> --stdin [options]
       dure send <session-id> --workspace <workspace-id> <text...> [options]

Options:
  --file PATH            Read exact UTF-8 text from a regular file (up to 64 KiB)
  --stdin                Read exact UTF-8 text from stdin until EOF (up to 64 KiB)
  --workspace ID         Exact local managed Session scope, independent of the app registry
  --no-enter             Insert text without submitting; edit the chat draft
  --draft-wait SECONDS   Wait up to SECONDS (0-60, default 30) for unsubmitted user input to clear
  --ignore-draft         Write even while the terminal holds unsubmitted user input
  --track                Send through the durable inbox; retain a private message tracking file
  --json                 Print the delivery receipt as JSON, without prompt text
  --window-label LABEL   Select the app window for input delivery
  --idempotency-key KEY   Reuse an input key through the running app broker
  -h, --help             Show this help before specifying a recipient
  --                     Stop parsing options

The recipient may be an agent name, project/name, or exact local managed Session ID.
Unregistered Sessions are inspected through Hmux and input is fenced to that generation.
Use --workspace to disambiguate. Remote input requires a registered Agent.
Messages after the recipient may include literal --help or -h text.
Choose exactly one text source. Newlines and whitespace in file/stdin are preserved.
Enter is sent by default; use --no-enter to insert without submitting.
Terminal input never merges into text the user has typed but not submitted: text and
Enter are one Host transaction, written only while the target has no such draft. A send
waits up to --draft-wait for the user to submit; if the draft remains it fails with
hmux_input_draft_pending and nothing written. The draft clears only when the user submits
it; erasing the text without Enter does not. Retry later, use --track, or --ignore-draft
to write anyway. A session started before the guard existed receives ordinary input, with
a warning on stderr; restart that session to guard it.
Tracked messages require a managed Session and support 'dure wait --message <receiptPath>'.
Tracked send cannot be combined with --no-enter or --idempotency-key.
Terminal receipts prove bytes were written to the PTY, not provider acceptance.
The provider owns whether Enter submits immediately or queues terminal input.
Structured chat uses the running app and reports sent, steered, queued or drafted.
With --no-enter, review the structured chat draft and use Send when ready.
Errors go to stderr with non-zero exit status; uncertain delivery is not retried.
A process watchdog timeout has deliveryState=outcome_unknown. Read and inspect the
target before retrying; a missing receipt does not prove the message was not sent.
For app connection failures, use dure diagnostics --json in the same channel.
Its recovery checks distinguish app availability from backend and session health.
`;

function extractSource(args) {
  const remaining = [];
  let source;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      remaining.push(...args.slice(index));
      break;
    }
    if (argument !== "--stdin" && argument !== "--file") {
      remaining.push(argument);
      continue;
    }
    if (source !== undefined) throw new Error("Choose exactly one input source");
    if (argument === "--stdin") source = 0;
    else {
      source = args[++index];
      if (!source || source.startsWith("-")) {
        throw new Error("--file requires a path (prefix option-like paths with ./)");
      }
    }
  }
  return { source, remaining };
}

const DEFAULT_DRAFT_WAIT_SECONDS = 30;
const MAX_DRAFT_WAIT_SECONDS = 60;

/** Draft-guard options precede `--` like the other send flags. The guard is
 * on by default; only an explicit --ignore-draft writes unguarded input. */
function extractDraftGuard(args) {
  const remaining = [];
  let waitSeconds;
  let ignore = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      remaining.push(...args.slice(index));
      break;
    }
    if (argument === "--ignore-draft") {
      ignore = true;
      continue;
    }
    if (argument === "--draft-wait") {
      const value = args[++index];
      if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > MAX_DRAFT_WAIT_SECONDS) {
        throw new Error(`--draft-wait requires whole seconds from 0 to ${MAX_DRAFT_WAIT_SECONDS}`);
      }
      waitSeconds = Number(value);
      continue;
    }
    remaining.push(argument);
  }
  if (ignore && waitSeconds !== undefined) throw new Error("Choose either --draft-wait or --ignore-draft");
  return {
    remaining,
    explicit: ignore || waitSeconds !== undefined,
    draftGuard: ignore ? null : { waitMs: (waitSeconds ?? DEFAULT_DRAFT_WAIT_SECONDS) * 1000 },
  };
}

const UNGUARDED_CAUSE = {
  app: "the running Dure app predates draft-guarded input. Restart the updated Dure app",
  hmux: "the selected hmux predates draft-guarded input. Update Hmux",
};

/** A guarded request that came back as ordinary input never checked the
 * user's draft; say so without changing the delivery receipt. */
function warnUnguarded(agent, input, opts) {
  const receipt = input?.receipt;
  if (!opts.draftGuard || !receipt || receipt.kind || receipt.atomic === true) return;
  const cause = UNGUARDED_CAUSE[input.unguardedReason] ??
    "its Hmux runtime predates draft-guarded input. Restart that session";
  process.stderr.write(
    `dure send: warning: ${agent.name} was sent without waiting for an unsubmitted user draft; ` +
      `${cause} to enable the guard.\n`,
  );
}

function printDelivery(agent, input, opts) {
  warnUnguarded(agent, input, opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      apiVersion: "dure.send/v1", ok: true,
      target: { agentId: agent.id, sessionId: input.sessionId, workspaceId: input.workspaceId },
      receipt: input.receipt,
    })}\n`);
    return;
  }
  if (input?.receipt?.kind === "durable_message") {
    process.stdout.write(`Message accepted: ${input.receipt.interactionId}\nTrack: dure wait --message ${JSON.stringify(input.receipt.receiptPath)} --json\n`);
    return;
  }
  if (input?.receipt?.kind === "structured_chat") {
    process.stdout.write(`\x1b[32m✓\x1b[0m ${agent.name} chat · ${input.receipt.delivery}\n`);
    return;
  }
  const recordId = input?.receipt?.submit?.recordId ?? input?.receipt?.text?.recordId;
  const receipt = recordId ? ` · receipt ${recordId}` : "";
  const guarded = input?.receipt?.atomic === true ? " (one draft-guarded write)" : "";
  process.stdout.write(`\x1b[32m✓\x1b[0m ${agent.name} · written to PTY${opts.enter ? " + Enter" : ""}${guarded}${receipt} · provider acceptance unconfirmed\n`);
}

function nameWords(name) {
  return String(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
}

/** Tracked-send failures are expected outcomes, so they print without a stack.
 * Names suggest where to resend; they do not prove the suggested Agent is alive. */
export function trackedSendFailureMessage(error, registry, agent) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code !== "dure_send_session_exited") return message;
  const name = typeof agent === "string" ? agent : agentDisplayName(agent);
  const words = new Set(nameWords(name));
  const similar = (registry?.agents ?? []).filter((candidate) =>
    candidate !== agent && candidate.sessionId !== error.sessionId &&
    nameWords(agentDisplayName(candidate)).some((word) => words.has(word)))
    .slice(0, 5).map((candidate) => `${candidate.project}/${agentDisplayName(candidate)}`);
  return [
    `${name} has exited (Session ${error.sessionId}). Nothing was sent.`,
    ...(similar.length ? [`Agents with similar names: ${similar.join(", ")}`] : []),
    "Find a live Agent with: dure ls --alive",
  ].join("\n");
}

export async function runSendCommand(
  args,
  { parseOptions, loadRegistry, resolveAgent, send, sendExactSession, sendTracked, fail },
) {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(SEND_HELP);
    return;
  }
  let parsed;
  let guard;
  try {
    parsed = extractSource(args);
    guard = extractDraftGuard(parsed.remaining);
  } catch (error) {
    return fail(error.message);
  }
  const { source } = parsed;
  const remaining = guard.remaining;
  const terminator = remaining.indexOf("--");
  const track = remaining.some((arg, index) => arg === "--track" && (terminator < 0 || index < terminator));
  const opts = parseOptions(remaining.filter((arg, index) => !(arg === "--track" && (terminator < 0 || index < terminator))));
  opts.draftGuard = guard.draftGuard;
  if (track && (!opts.enter || opts.idempotencyKey)) return fail("--track requires submission without --idempotency-key; reuse its tracking file after uncertainty.");
  if (track && guard.explicit) return fail("--track delivers through the durable inbox; --draft-wait and --ignore-draft apply only to terminal input.");
  if (source !== undefined && opts.rest.length > 1) {
    return fail("Choose exactly one input source: argv text, --file, or --stdin");
  }
  if (remaining.includes("--workspace") && !opts.workspace) return fail("--workspace requires an ID");
  if (opts.backendSpecified) return fail("send does not support --backend; use a registered remote Agent.");
  const registry = loadRegistry();
  const agent = resolveAgent(registry, opts.rest[0]);
  if (typeof agent !== "string" && opts.workspace && opts.workspace !== agent.runtimeBinding?.workspaceId) {
    return fail("--workspace does not match the selected Agent session");
  }
  let text;
  try {
    if (source === 0 && process.stdin.isTTY) {
      throw new Error("--stdin requires piped or redirected input, terminated by EOF");
    }
    text = source === undefined ? opts.rest.slice(1).join(" ")
      : source === 0 ? await readUtf8Stdin() : readUtf8Input(source);
  } catch (error) {
    return fail(error.message);
  }
  if (!text) return fail("Input text must not be empty");
  if (track) {
    let input;
    try {
      input = await sendTracked(agent, text, opts);
    } catch (error) {
      return fail(trackedSendFailureMessage(error, registry, agent));
    }
    printDelivery(typeof agent === "string" ? { name: agent } : agent, input, opts);
    return;
  }
  if (typeof agent === "string") {
    const input = await sendExactSession(agent, text, opts);
    printDelivery({ name: agent }, input, opts);
    return;
  }
  const input = await send(
    registry,
    agent,
    text,
    opts.enter,
    opts.windowLabel,
    opts.idempotencyKey,
    opts.draftGuard,
  );
  printDelivery(agent, input, opts);
}
