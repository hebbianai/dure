/** Shared client workflow; the backend owns stop, conversation/credential
 * preservation, revision checks, publication and durable request replay. */
export class ManagedRuntimeRecoveryIncompleteError extends Error {
  constructor(stage, observation) {
    super(`managed_runtime_recovery_${stage}_${observation.state}`);
    this.name = "ManagedRuntimeRecoveryIncompleteError";
    this.stage = stage;
    this.observation = observation;
  }
}

/** Inputs are decoded observations from the selected backend. Never infer a
 * stopped source from a transport failure, or replay a mutation automatically. */
export async function wakeManagedRuntime(source, { hibernate, wake }) {
  let dormant = source;
  if (source.state === "stable" && hibernate) {
    dormant = await hibernate(source);
    if (dormant.state !== "dormant") {
      throw new ManagedRuntimeRecoveryIncompleteError("hibernate", dormant);
    }
  }
  if (dormant.state !== "dormant") {
    throw new ManagedRuntimeRecoveryIncompleteError("source", dormant);
  }
  const result = await wake(dormant);
  if (result.state !== "stable") {
    throw new ManagedRuntimeRecoveryIncompleteError("wake", result);
  }
  return result;
}
