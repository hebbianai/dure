#!/usr/bin/env node
import { prepareReleaseCandidate } from "./lib/release-candidate.mjs";

const [bumpKind, baseSha, outputDirectory] = process.argv.slice(2);
if (!bumpKind || !baseSha || !outputDirectory) {
  console.error(
    "usage: prepare-release-candidate.mjs patch|minor BASE_SHA OUTPUT_DIRECTORY",
  );
  process.exit(2);
}

const manifest = prepareReleaseCandidate({
  baseSha,
  bumpKind,
  outputDirectory,
});
console.log(
  `${manifest.currentVersion} -> ${manifest.version} (${manifest.patchSha256})`,
);
