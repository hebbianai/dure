#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  applyVersionPrune,
  defaultDiscoveryRoots,
  planVersionPrune,
} from "./lib/hmux-version-gc.mjs";

function usage() {
  console.error(
    "usage: prune-hmux-versions.mjs [--apply] [--retain N] [--max-versions N] [--max-bytes N] [--install-root PATH] [--discovery-root PATH]",
  );
}

let apply = false;
let retain = 2;
let maxVersions = 32;
let maxTotalBytes = 512 * 1024 * 1024;
let installRoot = process.env.HMUX_INSTALL_ROOT;
if (!installRoot && process.env.HOME) {
  installRoot = path.join(process.env.HOME, ".local/share/hmux");
}
let discoveryRoots;
function nextValue(index, option) {
  const value = process.argv[index + 1];
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

try {
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--retain") {
      retain = Number(nextValue(index, argument));
      index += 1;
    } else if (argument === "--max-versions") {
      maxVersions = Number(nextValue(index, argument));
      index += 1;
    } else if (argument === "--max-bytes") {
      maxTotalBytes = Number(nextValue(index, argument));
      index += 1;
    } else if (argument === "--install-root") {
      installRoot = nextValue(index, argument);
      index += 1;
    } else if (argument === "--discovery-root") {
      if (discoveryRoots) {
        throw new Error("--discovery-root may be specified only once");
      }
      discoveryRoots = [path.resolve(nextValue(index, argument))];
      index += 1;
    } else {
      usage();
      process.exit(2);
    }
  }

  if (!installRoot) {
    console.error("HMUX_INSTALL_ROOT or HOME is required");
    process.exit(1);
  }
  discoveryRoots ??= defaultDiscoveryRoots();

  const plan = planVersionPrune({
    installRoot,
    discoveryRoots: [...new Set(discoveryRoots)],
    retain,
    maxVersions,
    maxTotalBytes,
  });
  const removed = apply ? applyVersionPrune(plan) : [];
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: apply ? "applied" : "dry_run",
        ...plan,
        removed,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`hmux version prune failed: ${error.message}`);
  process.exit(1);
}
