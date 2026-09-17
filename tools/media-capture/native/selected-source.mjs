export const VERIFIED_NATIVE_SOURCE_KIND =
  "verified-native-capture-selection-v1";

function isDigest(value) {
  return (
    Number.isSafeInteger(value?.bytes) &&
    value.bytes > 0 &&
    /^[a-f0-9]{64}$/u.test(value?.sha256 ?? "")
  );
}

export function assertVerifiedNativeSourceSelection(
  selection,
  { artifact, scenarioId } = {},
) {
  if (
    selection?.schemaVersion !== 1 ||
    selection?.sourceKind !== VERIFIED_NATIVE_SOURCE_KIND ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(selection?.scenarioId ?? "") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{12}$/u.test(
      selection?.runId ?? "",
    ) ||
    !/^[a-z0-9][a-z0-9.-]*\.(?:webm|mp4)$/u.test(
      selection?.files?.artifact?.name ?? "",
    ) ||
    !isDigest(selection?.files?.artifact) ||
    !isDigest(selection?.files?.cleanupReceipt) ||
    !isDigest(selection?.files?.manifest)
  ) {
    throw new Error("verified native source selection is invalid");
  }
  if (scenarioId !== undefined && selection.scenarioId !== scenarioId) {
    throw new Error("verified native source selection scenario does not match");
  }
  if (artifact !== undefined && selection.files.artifact.name !== artifact) {
    throw new Error("verified native source selection artifact does not match");
  }
  return selection;
}

export function verifiedNativeSourceSelection({
  artifact,
  cleanupReceipt,
  manifest,
  runId,
  scenarioId,
}) {
  return assertVerifiedNativeSourceSelection({
    schemaVersion: 1,
    sourceKind: VERIFIED_NATIVE_SOURCE_KIND,
    scenarioId,
    runId,
    files: {
      artifact,
      cleanupReceipt,
      manifest,
    },
  });
}
