#!/usr/bin/env node

import {
  STABLE_APP_CHANNEL,
  resolveAppChannel,
} from "./lib/app-channel.mjs";

let channel;
try {
  channel = resolveAppChannel();
} catch (error) {
  process.stderr.write(`Dure dev channel is invalid: ${error.message}\n`);
  process.exit(1);
}

if (channel === STABLE_APP_CHANNEL) {
  process.stderr.write(
    "Refusing an unisolated Tauri dev app.\n" +
      "Use `corepack pnpm app:dev` for a worktree-owned development instance.\n" +
      "Use `corepack pnpm app:daily:start` for the installed daily driver.\n",
  );
  process.exit(1);
}
