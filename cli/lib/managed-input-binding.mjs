export function managedInputFenceJson(binding) {
  if (binding?.runtime !== "hmux_managed_v1") return null;
  const fence = binding.stopFence;
  const fields = [
    binding.sessionId,
    binding.workspaceId,
    fence?.runnerPrincipal,
    fence?.runnerInstance,
    fence?.hostInstanceId,
    fence?.terminalEpoch,
  ];
  if (
    fields.some((value) => typeof value !== "string" || !value.trim()) ||
    typeof fence?.channelEpoch !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(fence.channelEpoch)
  ) {
    return null;
  }
  let channelEpoch;
  try {
    channelEpoch = BigInt(fence.channelEpoch);
  } catch {
    return null;
  }
  if (channelEpoch > 18_446_744_073_709_551_615n) return null;
  const quote = (value) => JSON.stringify(value);
  return (
    `{"workspace_id":${quote(binding.workspaceId)},` +
    `"session_id":${quote(binding.sessionId)},` +
    `"runner_principal":${quote(fence.runnerPrincipal)},` +
    `"runner_instance":${quote(fence.runnerInstance)},` +
    `"channel_epoch":${quote(fence.channelEpoch)},` +
    `"host_instance_id":${quote(fence.hostInstanceId)},` +
    `"terminal_epoch":${quote(fence.terminalEpoch)}}`
  );
}

export function controllableHmuxBinding(agent) {
  const binding = agent.runtimeBinding;
  return (binding?.runtime === "hmux_managed_v1" ||
    binding?.runtime === "hmux_standalone_v1") &&
    (binding.source === "local" || binding.source === "ssh") &&
    typeof binding.hostId === "string" &&
    binding.hostId.length > 0 &&
    binding.sessionId === agent.sessionId &&
    typeof binding.workspaceId === "string" &&
    binding.workspaceId.length > 0
    ? binding
    : null;
}
