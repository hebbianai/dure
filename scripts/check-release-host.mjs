#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { observeHostResources } from "./lib/host-resource-admission.mjs";
import {
  RELEASE_HOST_MAX_LOAD_PER_CORE,
  assessReleaseHost,
  waitForReleaseHost,
} from "./lib/release-host-admission.mjs";

const HELP = `Usage: node scripts/check-release-host.mjs [--max-load-per-core N] [--wait-minutes M]
Refuse to start release work on an overloaded host, before a version is
reserved. With --wait-minutes it first waits up to M minutes for the host to
drop under the limit; without it the check is point-in-time. It never stops
any work. Exit 1 with release_host_overloaded, release_host_memory_critical or
release_host_load_unavailable on stderr; the JSON receipt goes to stdout.
  --max-load-per-core N   One-minute load average / logical cores
                          (default ${RELEASE_HOST_MAX_LOAD_PER_CORE}; see scripts/lib/release-host-admission.mjs)
  --wait-minutes M        Whole minutes to wait for that limit first (default 0)
`;

export async function runReleaseHostCheck(
  args,
  {
    observe = observeHostResources,
    waitForHost,
    log = (line) => process.stderr.write(`[release-host] ${line}\n`),
  } = {},
) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean" },
      "max-load-per-core": { type: "string" },
      "wait-minutes": { type: "string" },
    },
  });
  if (values.help) return { help: HELP };
  const limit = values["max-load-per-core"];
  const maxLoadPerCore =
    limit === undefined ? RELEASE_HOST_MAX_LOAD_PER_CORE : Number(limit);
  const wait = values["wait-minutes"] ?? "0";
  if (!/^\d{1,4}$/u.test(wait)) {
    throw new Error("release_host_wait_invalid: --wait-minutes takes a whole number of minutes");
  }
  const waitMinutes = Number(wait);
  if (waitMinutes > 0) {
    await waitForReleaseHost({
      label: "release host admission",
      maxWaitMs: waitMinutes * 60_000,
      maxLoadPerCore,
      log,
      waitForHost,
    });
  }
  const observation = await observe();
  return {
    ...assessReleaseHost(observation, { maxLoadPerCore }),
    observedAt: observation.observedAt,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseHostCheck(process.argv.slice(2))
    .then((result) => {
      if (result.help) {
        process.stdout.write(result.help);
        return;
      }
      const { message, ...receipt } = result;
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      if (result.ok) {
        process.stdout.write(`${message}\n`);
      } else {
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
