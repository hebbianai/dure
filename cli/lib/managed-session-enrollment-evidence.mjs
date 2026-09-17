const encoder = new TextEncoder();
const requiredCapabilities = [
  "event_cursor_v1",
  "idempotent_delivery_receipt_v1",
];

function boundedReference(value) {
  if (typeof value !== "string") return false;
  const byteLength = encoder.encode(value).length;
  return (
    byteLength > 0 &&
    byteLength <= 256 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  );
}

export function managedSessionEnrollmentEvidence(
  session,
  integrationReceipt,
  predecessor,
) {
  const capabilities = integrationReceipt?.capabilities;
  if (
    ![
      session?.sessionId,
      session?.workspaceId,
      session?.providerId,
      session?.runnerPrincipal,
      session?.runnerInstance,
      session?.channelEpoch,
      session?.hostInstanceId,
      session?.terminalEpoch,
      integrationReceipt?.installRootRef,
      integrationReceipt?.version,
      integrationReceipt?.channel,
    ].every(boundedReference) ||
    typeof integrationReceipt?.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(integrationReceipt.digest) ||
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    capabilities.length > 16 ||
    new Set(capabilities).size !== capabilities.length ||
    !capabilities.every(boundedReference) ||
    !requiredCapabilities.every((capability) => capabilities.includes(capability))
  ) {
    throw new Error("managed Session enrollment identity is invalid");
  }
  if (
    predecessor !== undefined &&
    (!boundedReference(predecessor?.dispatchId) ||
      !Number.isSafeInteger(predecessor?.generation) ||
      predecessor.generation < 1)
  ) {
    throw new Error("managed Session enrollment predecessor is invalid");
  }
  return JSON.stringify([
    "dure.run.enroll/v1",
    session.sessionId,
    session.workspaceId,
    session.providerId,
    session.runnerPrincipal,
    session.runnerInstance,
    session.channelEpoch,
    session.hostInstanceId,
    session.terminalEpoch,
    integrationReceipt.installRootRef,
    integrationReceipt.version,
    integrationReceipt.digest,
    integrationReceipt.channel,
    capabilities,
    ...(predecessor === undefined
      ? []
      : ["successor", predecessor.dispatchId, predecessor.generation]),
  ]);
}
