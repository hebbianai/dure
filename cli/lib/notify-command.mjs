import { parseArgs } from "node:util";
import { requestAppControl } from "./app-control-client.mjs";

export const NOTIFY_CAPABILITY = "agent.notify_v1";
const MAX_CODE_POINTS = 280;
const MAX_SESSION_ID_LENGTH = 512;

export const NOTIFY_HELP = `dure notify <message...> [--json]

Show the person one short message as a desktop notification from the running
Dure app on this computer. Inside an agent's pane it is titled with that agent
and project, and clicking it opens the agent; anywhere else it is titled
"Message from a command". The phone does not receive these messages yet.

Words are joined with spaces. The message is 1 to 280 characters; line breaks
are kept, and other control characters or invisible characters that reorder or
hide text are refused. Each sender may send 3 at once, then 1 every 20 seconds,
and at most 30 an hour. Settings > Notifications > Messages from agents turns
them off. Agents on SSH or remote hosts cannot reach the app.

Exit 0 when the message was shown, 1 when nothing was shown (notifications
off, rate limited, failed, or no running app), 2 for a usage error.
--json prints the receipt; put -- before a message that starts with -.`;

/** The app's admission rules, checked first so a mistake is reported at
 *  once. The app applies them again and its answer is the one that counts. */
export function noticeTextProblem(text) {
  const characters = [...text];
  if (text.trim() === "") return { reason: "empty", message: "The message is empty." };
  if (characters.length > MAX_CODE_POINTS) {
    return { reason: "too_long", message: `The message is longer than ${MAX_CODE_POINTS} characters.` };
  }
  if (characters.some((character) => character !== "\n" && /\p{Cc}/u.test(character))) {
    return { reason: "control_character", message: "The message contains a control character; only line breaks are allowed." };
  }
  if (characters.some(reordersOrHidesText)) {
    return { reason: "format_character", message: "The message contains an invisible character that reorders or hides text." };
  }
  return null;
}

function reordersOrHidesText(character) {
  const code = character.codePointAt(0);
  return (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
}

/** This pane's Session, which the app resolves to the sending agent. */
function senderSessionId(environment) {
  const sessionId = environment.HMUX_SESSION_ID?.trim();
  return sessionId && sessionId.length <= MAX_SESSION_ID_LENGTH && !/\p{Cc}/u.test(sessionId)
    ? sessionId
    : undefined;
}

function surface({ status, reason }) {
  const label = status.replaceAll("_", " ");
  return reason ? `${label} (${reason})` : label;
}

/** One line for a person reading the terminal. */
export function describeNotifyReceipt(receipt) {
  if (receipt.status === "rate_limited") {
    const seconds = Math.max(1, Math.ceil((receipt.retryAfterMs ?? 0) / 1000));
    return `Rate limited; nothing was shown. Try again in ${seconds} s.`;
  }
  const sender = receipt.agent
    ? [receipt.agent.name, receipt.agent.project].filter(Boolean).join(" · ")
    : "a command";
  const outcome = receipt.status === "delivered" ? "Delivered" : "Not delivered";
  return `${outcome} from ${sender}: desktop ${surface(receipt.desktop)}, phone ${surface(receipt.phone)}.`;
}

/**
 * Runs `dure notify` and returns its exit code. The app owns the text rules,
 * the rate limit and the receipt; this checks the rules early and prints.
 */
export async function runNotifyCommand(args, {
  loadDescriptor,
  environment = process.env,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  request = requestAppControl,
}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } }));
  } catch (error) {
    stderr(`${error.message}\n\n${NOTIFY_HELP}\n`);
    return 2;
  }
  if (values.help) {
    stdout(`${NOTIFY_HELP}\n`);
    return 0;
  }
  const refuse = (code, message, extra = {}) => {
    stderr(values.json
      ? `${JSON.stringify({ ok: false, error: { code, message, ...extra } })}\n`
      : `${message}\n`);
  };
  if (positionals.length === 0) {
    refuse("notify_usage", `A message is required.\n\n${NOTIFY_HELP}`);
    return 2;
  }
  const message = positionals.join(" ").trim();
  const problem = noticeTextProblem(message);
  if (problem) {
    refuse("notify_message_invalid", problem.message, { reason: problem.reason });
    return 2;
  }
  const descriptor = loadDescriptor();
  if (!descriptor) {
    refuse("client_unavailable",
      "No running Dure app was found on this computer, so nothing was shown. dure notify shows messages through the app; agents on SSH or remote hosts cannot reach it.");
    return 1;
  }
  if (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.includes(NOTIFY_CAPABILITY)) {
    refuse("client_outdated", "Please update the running Dure app: it does not support dure notify yet. Nothing was shown.");
    return 1;
  }
  const sessionId = senderSessionId(environment);
  let receipt;
  try {
    receipt = await request({ descriptor, path: "/agent/notify", body: { message, ...(sessionId ? { sessionId } : {}) } });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "client_request_failed";
    refuse(code, error instanceof Error ? error.message : String(error));
    return code === "notify_message_invalid" ? 2 : 1;
  }
  stdout(`${values.json ? JSON.stringify(receipt) : describeNotifyReceipt(receipt)}\n`);
  return receipt.status === "delivered" ? 0 : 1;
}
