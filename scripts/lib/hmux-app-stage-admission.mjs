import { devDeployLockAuthorizes } from "./dev-deploy-lock.mjs";

export const HMUX_STAGE_AUTHORIZATION_ENV =
  "DURE_HMUX_STAGE_DEPLOY_AUTHORIZATION";

export function admitHmuxAppStage({ appRuntime, deployLock, authorization }) {
  if (deployLock && devDeployLockAuthorizes(deployLock, authorization)) {
    return { admitted: true, authority: "dev_deploy_lock" };
  }
  if (!appRuntime && !deployLock) {
    return { admitted: true, authority: "inactive_worktree" };
  }
  return {
    admitted: false,
    reason:
      "active app runtime staging requires the exact dev deploy transaction; run app:dev:deploy instead of replacing its backend input directly",
  };
}
