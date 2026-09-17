import assert from "node:assert/strict";
import { worktreeReleasePlan } from "../lib/worktree-release.mjs";
import { runWorktreeRelease } from "../run-worktree-release.mjs";

const plan = worktreeReleasePlan(process.cwd(), process.env.HEBBIAN_DEV_INSTANCE, {
  app: { windows: [{}] },
});
assert.equal(process.env.DURE_APP_CHANNEL, plan.profile.sourceChannel);
const args = process.argv.slice(2);
await runWorktreeRelease(args.length ? args : ["build"], {
  qa: {
    stateRoot: process.env.DURE_QA_STATE_ROOT,
    windows: process.env.DURE_QA_WINDOW_PLAN_JSON,
  },
});
