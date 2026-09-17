import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
assert.match(path.basename(root), /^dure-frozen-command-/u);
assert.equal(
  fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT),
  path.join(root, "hmux-discovery"),
);
const identityModule = new URL("../../lib/process-identity.mjs", import.meta.url);
const actual = await import(identityModule.href);
mock.module(identityModule, {
  exports: {
    ...actual,
    observeProcessMembers(request, options) {
      if (fs.existsSync(path.join(root, "refuse-observation"))) {
        if (request.kind === "user_census") {
          fs.appendFileSync(
            path.join(root, "refused-censuses.log"),
            `${JSON.stringify(request)}\n`,
          );
          throw new Error("injected second broad census refusal");
        }
        if (
          request.kind === "point" &&
          process.env.DURE_QA_FROZEN_POINT_FAILURE === "1"
        ) {
          throw new Error("injected frozen point refusal");
        }
      }
      return actual.observeProcessMembers(request, options);
    },
  },
});

const { supervise } = await import("./owned-process-group.mjs");
try {
  process.exitCode = await supervise(
    path.join(root, "group.json"),
    process.execPath,
    [path.join(root, "worker.mjs")],
    { terminateDetachedOwnedGenerations: true },
  );
} catch (error) {
  console.error(error);
  process.exitCode = 97;
}
