import { readUtf8Input, readUtf8Stdin } from "./text-input.mjs";

const SEND_HELP = `dure send — Send text to an agent

Usage: dure send <name> <text...> [options]
       dure send <name> --file PATH [options]
       dure send <name> --stdin [options]

Options:
  --file PATH            Read exact UTF-8 text from a regular file (up to 64 KiB)
  --stdin                Read exact UTF-8 text from stdin until EOF (up to 64 KiB)
  --no-enter             Insert text without submitting; edit the chat draft
  --json                 Print the delivery receipt as JSON, without prompt text
  --window-label LABEL   Select the app window for input delivery
  --idempotency-key KEY   Reuse an input key through the running app broker
  -h, --help             Show this help before specifying a recipient
  --                     Stop parsing options

The recipient may be an agent name, project/name, or session ID.
Messages after the recipient may include literal --help or -h text.
Choose exactly one text source. Newlines and whitespace in file/stdin are preserved.
Enter is sent by default; use --no-enter to insert without submitting.
Terminal receipts prove bytes were written to the PTY, not provider acceptance.
The provider owns whether Enter submits immediately or queues terminal input.
Structured chat uses the running app and reports sent, steered, queued or drafted.
With --no-enter, review the structured chat draft and use Send when ready.
Errors go to stderr with non-zero exit status; uncertain delivery is not retried.
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

function printDelivery(agent, input, opts) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      apiVersion: "dure.send/v1", ok: true,
      target: { agentId: agent.id, sessionId: input.sessionId, workspaceId: input.workspaceId },
      receipt: input.receipt,
    })}\n`);
    return;
  }
  if (input?.receipt?.kind === "structured_chat") {
    process.stdout.write(`\x1b[32m✓\x1b[0m ${agent.name} chat · ${input.receipt.delivery}\n`);
    return;
  }
  const recordId = input?.receipt?.submit?.recordId ?? input?.receipt?.text?.recordId;
  const receipt = recordId ? ` · receipt ${recordId}` : "";
  process.stdout.write(`\x1b[32m✓\x1b[0m ${agent.name} · written to PTY${opts.enter ? " + Enter" : ""}${receipt} · provider acceptance unconfirmed\n`);
}

export async function runSendCommand(
  args,
  { parseOptions, loadRegistry, resolveAgent, send, fail },
) {
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(SEND_HELP);
    return;
  }
  let parsed;
  try {
    parsed = extractSource(args);
  } catch (error) {
    return fail(error.message);
  }
  const { source, remaining } = parsed;
  const opts = parseOptions(remaining);
  if (source !== undefined && opts.rest.length > 1) {
    return fail("Choose exactly one input source: argv text, --file, or --stdin");
  }
  const registry = loadRegistry();
  const agent = resolveAgent(registry, opts.rest[0]);
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
  const input = await send(
    registry,
    agent,
    text,
    opts.enter,
    opts.windowLabel,
    opts.idempotencyKey,
  );
  printDelivery(agent, input, opts);
}
