import { test, expect } from "vitest";
import { profileRecoveryFailure } from "../cli/lib/browser-profile-recovery.mjs";
import { browserProfileRecoveryAction } from "../cli/lib/contracts/browser-profile-recovery.mjs";

test.each([
  ["browser_profile_exit_unconfirmed", "recover", "profile recover"],
  ["browser_profile_recovery_restart_required", "restart", "restart the computer"],
  ["browser_profile_owner_live", "wait", "Close the Browser"],
  ["browser_profile_recovery_in_progress", "wait", "concurrent recovery"],
  ["browser_profile_recovery_unconfirmed", "inspect", "Keep the profile intact"],
])("%s provides actionable guidance without changing the backend failure", (remoteCode, action, instruction) => {
  const failure = {code:"backend_transport_remote_error", remoteCode, disposition:"terminal"};
  expect(browserProfileRecoveryAction(remoteCode)).toBe(action);
  expect(profileRecoveryFailure(failure)).toMatchObject(failure);
  expect(profileRecoveryFailure(failure).nextAction).toContain(instruction);
});

test("unrelated errors are unchanged", () => {
  const error = {code:"browser_action_failed"};
  expect(profileRecoveryFailure(error)).toBe(error);
});

test("a replayed failed operation retains actionable recovery guidance", async () => {
  const {collectBrowserCommand} = await import("../cli/lib/browser-command.mjs");
  const result = await collectBrowserCommand({args:["create", "--idempotency-key", "failed-once"],
    resolveBackend:async()=>({profile:{id:"local"}}),
    requestBackend:async()=>({result:{replayed:true,result:null,error:{code:"browser_profile_exit_unconfirmed"},receipt:{state:"failed"}}}),
  });
  expect(result.ok).toBe(false);
  expect(result.error.nextAction).toContain("profile recover");
});
