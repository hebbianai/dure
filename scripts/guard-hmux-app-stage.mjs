#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { worktreeDevIdentity } from "./lib/app-channel.mjs";
import { appRuntimeObservation } from "./lib/dev-app-runtime.mjs";
import { readOwnedDevDeployLock } from "./lib/dev-deploy-lock.mjs";
import {
  HMUX_STAGE_AUTHORIZATION_ENV,
  admitHmuxAppStage,
} from "./lib/hmux-app-stage-admission.mjs";

export function assertHmuxAppStageAdmission(
  root = realpathSync(process.cwd()),
  environment = process.env,
) {
  const { channel } = worktreeDevIdentity(root);
  const admission = admitHmuxAppStage({
    appRuntime: appRuntimeObservation(root),
    deployLock: readOwnedDevDeployLock({ worktreeRoot: root, channel }),
    authorization: environment[HMUX_STAGE_AUTHORIZATION_ENV],
  });
  if (!admission.admitted) throw new Error(admission.reason);
  return admission;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    assertHmuxAppStageAdmission();
  } catch (error) {
    console.error(`Hmux app stage refused: ${error.message}`);
    process.exitCode = 1;
  }
}
