#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  DEV_INSTANCE_ENV,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const worktreeRoot = realpathSync(
  execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  }).trim(),
);

process.stdout.write(
  `${worktreeDevIdentity(worktreeRoot, process.env[DEV_INSTANCE_ENV]).channel}\n`,
);
