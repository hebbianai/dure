#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  FOREGROUND_GUARD_INTERVAL_MS,
  renderPriorityTimeline,
  startForegroundPriorityGuard,
} from "./lib/foreground-priority-guard.mjs";

const HELP = `Usage: node scripts/run-with-foreground-priority.mjs [--label TEXT] -- <command> [args...]
Run a command and keep its process tree out of Darwin background QoS: right
away and every ${FOREGROUND_GUARD_INTERVAL_MS / 1000} s it lifts PRIO_DARWIN_BG (taskpolicy -B) from every process
in the tree. It prints a ::warning:: when a background demotion or a raised
nice is first seen and appends the nice/QoS timeline to $GITHUB_STEP_SUMMARY
(stderr without one). On other platforms it only runs the command. Exits with
the command's status.
  --label TEXT   What the command is, in warnings and the summary (default "command")
`;

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function parseForegroundPriorityCommand(args) {
  if (args.length === 1 && args[0] === "--help") return { help: HELP };
  const separator = args.indexOf("--");
  if (separator === -1 || separator === args.length - 1) {
    throw new Error("usage: run-with-foreground-priority.mjs [--label TEXT] -- <command> [args...]");
  }
  const { values } = parseArgs({
    args: args.slice(0, separator),
    options: { label: { type: "string", default: "command" } },
  });
  return { label: values.label, command: args[separator + 1], args: args.slice(separator + 2) };
}

export async function runWithForegroundPriority(
  args,
  {
    environment = process.env,
    run = spawn,
    startGuard = startForegroundPriorityGuard,
    writeSummary = (markdown) =>
      environment.GITHUB_STEP_SUMMARY
        ? fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, markdown)
        : process.stderr.write(markdown),
    ...guardOptions
  } = {},
) {
  const parsed = parseForegroundPriorityCommand(args);
  if (parsed.help) {
    process.stdout.write(parsed.help);
    return 0;
  }
  const child = run(parsed.command, parsed.args, { env: environment, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  const guard = child.pid ? startGuard({ rootPid: child.pid, label: parsed.label, ...guardOptions }) : null;
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    if (signal) throw new Error(`${parsed.command} exited from signal ${signal}`);
    return code ?? 1;
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, forward);
    const timeline = await guard?.stop();
    if (timeline) writeSummary(renderPriorityTimeline(timeline));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWithForegroundPriority(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
