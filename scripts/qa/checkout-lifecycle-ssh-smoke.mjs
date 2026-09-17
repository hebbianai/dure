#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { cargoArtifact, run } from "./managed-provider-fixture.mjs";

export async function runCheckoutLifecycleSshSmoke() {
  const executable = await cargoArtifact([
    "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "--no-run",
  ], "agent_ide_lib", { kind: "qa" });
  return run(process.execPath, ["scripts/qa/checkout-registration-ssh-smoke.mjs"], {
    env: { ...process.env, DURE_QA_CHECKOUT_TAURI_TEST_BINARY: executable },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(await runCheckoutLifecycleSshSmoke());
}
