#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REPORT_MAX_BYTES = 64 * 1024;
const REPORT_TIMEOUT_MS = 2_000;

function readReport(executable, args, label) {
  try {
    return JSON.parse(
      execFileSync(executable, args, {
        encoding: "utf8",
        maxBuffer: REPORT_MAX_BYTES,
        stdio: ["ignore", "pipe", "inherit"],
        timeout: REPORT_TIMEOUT_MS,
      }),
    );
  } catch {
    throw new Error(
      `installed Hmux ${label} did not report valid build information`,
    );
  }
}

export function verifyHmuxDevActivation({ expectedBuildId, cli, runtime }) {
  if (
    cli?.schemaVersion !== 2 ||
    cli.buildInfo?.source !== "hmux_cli" ||
    cli.buildInfo?.buildId !== expectedBuildId
  ) {
    throw new Error("installed Hmux CLI did not report the activated build");
  }
  if (
    runtime?.schemaVersion !== 1 ||
    runtime.source !== "hmux_runtime" ||
    runtime.buildId !== expectedBuildId
  ) {
    throw new Error("installed Hmux runtime did not report the activated build");
  }
}

function main() {
  const [expectedBuildId, cliExecutable, runtimeExecutable] =
    process.argv.slice(2);
  if (!expectedBuildId || !cliExecutable || !runtimeExecutable) {
    throw new Error(
      "usage: verify-hmux-dev-activation.mjs <build-id> <hmux> <hmux-runtime>",
    );
  }
  verifyHmuxDevActivation({
    expectedBuildId,
    cli: readReport(cliExecutable, ["capabilities", "--json"], "CLI"),
    runtime: readReport(
      runtimeExecutable,
      ["--no-autostart", "hmux-build-info"],
      "runtime",
    ),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
