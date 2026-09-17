const OVERRIDE_SCHEMA_VERSION = 3;
const MAX_ENCODED_BYTES = 131_072;
const MAX_REPLAY_STEPS = 24;

function encodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeUtf8(value) {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function validatePayload(payload, scenario) {
  if (
    payload?.schemaVersion !== OVERRIDE_SCHEMA_VERSION ||
    payload.scenarioId !== scenario.id ||
    !payload.terminalSnapshots ||
    typeof payload.terminalSnapshots !== "object" ||
    !payload.terminalSnapshotGeometry ||
    typeof payload.terminalSnapshotGeometry !== "object"
  ) {
    throw new Error("native media snapshot override envelope is invalid");
  }
  const knownSessions = new Set(
    scenario.fixture.agents.map(({ sessionId }) => sessionId),
  );
  const snapshotIds = Object.keys(payload.terminalSnapshots);
  const geometryIds = Object.keys(payload.terminalSnapshotGeometry);
  if (
    snapshotIds.length === 0 ||
    snapshotIds.some(
      (sessionId) =>
        !knownSessions.has(sessionId) ||
        typeof payload.terminalSnapshots[sessionId] !== "string" ||
        payload.terminalSnapshots[sessionId].length === 0,
    )
  ) {
    throw new Error("native media snapshot override references an invalid session");
  }
  if (
    geometryIds.length !== snapshotIds.length ||
    snapshotIds.some(
      (sessionId) =>
        !Object.hasOwn(payload.terminalSnapshotGeometry, sessionId),
    ) ||
    Object.entries(payload.terminalSnapshotGeometry).some(
      ([sessionId, geometry]) =>
        !snapshotIds.includes(sessionId) ||
        !Number.isInteger(geometry?.columns) ||
        geometry.columns < 40 ||
        !Number.isInteger(geometry?.rows) ||
        geometry.rows < 12,
    )
  ) {
    throw new Error("native media snapshot override geometry is invalid");
  }
  if (
    !Array.isArray(payload.replaySteps) ||
    payload.replaySteps.length > MAX_REPLAY_STEPS
  ) {
    throw new Error("native media snapshot override replay is invalid");
  }
  let previousAtMs = -1;
  for (const step of payload.replaySteps) {
    if (
      !Number.isSafeInteger(step?.atMs) ||
      step.atMs < previousAtMs ||
      step.atMs > 15_000 ||
      !snapshotIds.includes(step.id) ||
      !["pty", "ssh"].includes(step.kind) ||
      !Number.isInteger(step.columns) ||
      step.columns < 40 ||
      step.columns > 400 ||
      !Number.isInteger(step.rows) ||
      step.rows < 12 ||
      step.rows > 200 ||
      typeof step.repaintBase64 !== "string" ||
      step.repaintBase64.length === 0 ||
      step.repaintBase64.length > 65_536 ||
      step.repaintBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        step.repaintBase64,
      ) ||
      typeof step.sequenceThrough !== "string" ||
      step.sequenceThrough.length === 0 ||
      step.sequenceThrough.length > 64
    ) {
      throw new Error("native media snapshot override replay is invalid");
    }
    previousAtMs = step.atMs;
  }
  const controlSegments =
    typeof payload.replayControlUrl === "string"
      ? payload.replayControlUrl.split("/").filter(Boolean)
      : [];
  if (
    (payload.replaySteps.length === 0 && payload.replayControlUrl !== null) ||
    (payload.replaySteps.length > 0 &&
      (controlSegments.length !== 6 ||
        controlSegments[0] !== "output" ||
        controlSegments[1] !== "playwright" ||
        controlSegments[2] !== "native-multi-window" ||
        controlSegments[3] !== scenario.id ||
        !/^[0-9TZ:.-]+-[a-f0-9]{12}$/u.test(controlSegments[4]) ||
        controlSegments[5] !== "replay-start.json"))
  ) {
    throw new Error("native media snapshot override replay control is invalid");
  }
  return payload;
}

export function encodeNativeSnapshotOverride(
  scenario,
  replaySteps = [],
  replayControlUrl = null,
) {
  const sessionIds = new Set(
    scenario.fixture.agents.map(({ sessionId }) => sessionId),
  );
  const terminalSnapshots = Object.fromEntries(
    Object.entries(scenario.fixture.terminalSnapshots ?? {}).filter(
      ([sessionId]) => sessionIds.has(sessionId),
    ),
  );
  const terminalSnapshotGeometry = Object.fromEntries(
    Object.entries(scenario.fixture.terminalSnapshotGeometry ?? {}).filter(
      ([sessionId]) => Object.hasOwn(terminalSnapshots, sessionId),
    ),
  );
  const payload = validatePayload(
    {
      schemaVersion: OVERRIDE_SCHEMA_VERSION,
      scenarioId: scenario.id,
      terminalSnapshots,
      terminalSnapshotGeometry,
      replayControlUrl,
      replaySteps: replaySteps.map(
        ({ atMs, id, kind, columns, rows, repaintBase64, sequenceThrough }) => ({
          atMs,
          id,
          kind,
          columns,
          rows,
          repaintBase64,
          sequenceThrough,
        }),
      ),
    },
    scenario,
  );
  const encoded = encodeUtf8(JSON.stringify(payload));
  if (encoded.length > MAX_ENCODED_BYTES) {
    throw new Error("native media snapshot override exceeds its transport budget");
  }
  return encoded;
}

export function applyNativeSnapshotOverride(scenario, encoded) {
  if (typeof encoded !== "string" || encoded.length > MAX_ENCODED_BYTES) {
    throw new Error("native media snapshot override is missing or oversized");
  }
  let decoded;
  try {
    decoded = JSON.parse(decodeUtf8(encoded));
  } catch (error) {
    throw new Error("native media snapshot override is not valid JSON", {
      cause: error,
    });
  }
  const payload = validatePayload(decoded, scenario);
  const copy = structuredClone(scenario);
  Object.assign(copy.fixture.terminalSnapshots, payload.terminalSnapshots);
  copy.fixture.terminalSnapshotGeometry = {
    ...(copy.fixture.terminalSnapshotGeometry ?? {}),
    ...payload.terminalSnapshotGeometry,
  };
  copy.liveProviderSessionIds = Object.keys(payload.terminalSnapshots);
  copy.nativeTerminalReplay = {
    schemaVersion: 1,
    controlUrl: payload.replayControlUrl,
    steps: payload.replaySteps,
  };
  return copy;
}
