import { browserProfileRecoveryAction } from "./contracts/browser-profile-recovery.mjs";

export function profileRecoveryFailure(error) {
  const action = browserProfileRecoveryAction(error?.remoteCode ?? error?.code);
  const nextAction = {
    recover: "Inspect with dure browser tab profile status --profile ID, then run dure browser tab profile recover --profile ID --idempotency-key KEY on the same backend. Browser create uses default unless --profile selects another profile. Recovery preserves cookies and local storage.",
    restart: "Save your work and restart the computer running this backend, then run profile recover again with a new idempotency key. This older or interrupted claim lacks complete writer evidence; restarting only Dure is insufficient. Keep the profile and its lock files intact.",
    wait: "Close the Browser using this profile through its owning Dure backend, then inspect profile status and retry recovery with a new idempotency key. A live owner or concurrent recovery still holds the profile.",
    inspect: "Writer ownership could not be verified. Keep the profile intact and inspect the owning backend's diagnostics; do not delete native-claim.json or Chromium lock files.",
  }[action];
  return nextAction ? { ...error, nextAction } : error;
}
