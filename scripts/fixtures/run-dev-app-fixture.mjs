#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchDetachedDevApp, runDevApp } from "../run-dev-app.mjs";

function assertFixtureHeadroom() {
  if (process.env.DURE_TEST_HEADROOM_EVENTS) {
    appendFileSync(process.env.DURE_TEST_HEADROOM_EVENTS, "headroom\n");
  }
  if (process.env.DURE_TEST_HEADROOM_MODE === "refuse") {
    throw new Error("fixture low headroom");
  }
  if (process.env.DURE_TEST_HEADROOM_MODE !== "allow") {
    throw new Error("fixture headroom mode is invalid");
  }
  return { reservation: null };
}

const detached = process.env.DURE_TEST_DETACHED === "1" &&
  !process.argv.includes("--internal-supervisor");
const launch = detached
  ? launchDetachedDevApp({ supervisorEntrypoint: fileURLToPath(import.meta.url) })
  : runDevApp({ assertLaunchHeadroom: assertFixtureHeadroom });
launch.catch((error) => {
  process.stderr.write(`app:dev: ${error.message}\n`);
  process.exitCode = 1;
});
