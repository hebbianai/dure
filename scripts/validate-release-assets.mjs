#!/usr/bin/env node
import fs from "node:fs";
import { inspectReleaseBundle } from "./lib/release-bundle-contract.mjs";
import { verifyMacosDistribution } from "./lib/macos-distribution-verification.mjs";

const [bundleRoot, githubOutput] = process.argv.slice(2);
if (!bundleRoot || !githubOutput) {
  console.error(
    "usage: validate-release-assets.mjs <tauri-bundle-root> <github-output>",
  );
  process.exit(2);
}

try {
  const assets = inspectReleaseBundle(bundleRoot);
  verifyMacosDistribution(assets, process.env.APPLE_SIGNING_IDENTITY);
  fs.appendFileSync(
    githubOutput,
    [`dmg=${assets.dmg}`, `tarball=${assets.tarball}`, `sig=${assets.signature}`].join(
      "\n",
    ) + "\n",
  );
  console.log(`release bundle verified: ${assets.app}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
