/** Shared semantic recovery guidance. Native ownership remains backend-owned. */
export function browserProfileRecoveryAction(code) {
  if (code === "browser_profile_exit_unconfirmed") return "recover";
  if (code === "browser_profile_recovery_restart_required") return "restart";
  if (code === "browser_profile_owner_live" || code === "browser_profile_recovery_in_progress") return "wait";
  if (code === "browser_profile_recovery_unconfirmed") return "inspect";
  return undefined;
}
