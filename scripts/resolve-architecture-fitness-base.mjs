#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { resolveArchitectureFitnessCiBase } from "./lib/architecture-fitness-base.mjs";

if (process.argv.length !== 2) {
  throw new Error("resolve architecture fitness base takes no arguments");
}

const base = resolveArchitectureFitnessCiBase(
  path.resolve(process.cwd()),
  process.env.DURE_ARCHITECTURE_PUSH_BEFORE,
);
process.stdout.write(`base_sha=${base}\n`);
