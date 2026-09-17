export const NATIVE_WINDOW_CAPTURE_SCHEMA_VERSION = 2;

const WINDOW_SCENARIOS = Object.freeze({
  "workspace-overview": Object.freeze([
    {
      create: true,
      desktopId: "desk-review",
      label: "main",
      name: "Review",
      surface: "desktop",
      width: 840,
      height: 650,
      x: 48,
      y: 96,
    },
    {
      create: true,
      desktopId: "desk-operate",
      label: "native-operate",
      name: "Operate",
      surface: "desktop",
      width: 840,
      height: 650,
      x: 936,
      y: 248,
    },
  ]),
  "hmux-multiple-views": Object.freeze([
    {
      create: true,
      desktopId: "desk-observe",
      label: "main",
      name: "Observe workspace",
      surface: "desktop",
      width: 1_180,
      height: 760,
      x: 48,
      y: 86,
    },
    {
      agentId: "agent-runtime-observer",
      create: false,
      desktopId: "desk-observe",
      label: "win-session-agent-runtime-observer",
      name: "runtime-observer",
      surface: "session",
      width: 1_180,
      height: 880,
      x: 650,
      y: 100,
    },
  ]),
});

const PROOF = /^[0-9a-f]{32}$/u;

function scenarioWindows(scenarioId) {
  const windows = WINDOW_SCENARIOS[scenarioId];
  if (!windows) {
    throw new Error(`native multi-window scenario is unsupported: ${scenarioId}`);
  }
  return windows;
}

export function assertNativeWindowProof(proof) {
  if (typeof proof !== "string" || !PROOF.test(proof)) {
    throw new Error("native media proof must be 32 lowercase hexadecimal characters");
  }
  return proof;
}

export function nativeWindowReadyTitle({
  desktopId,
  label,
  proof,
  scenarioId = "workspace-overview",
}) {
  assertNativeWindowProof(proof);
  const window = scenarioWindows(scenarioId).find(
    (candidate) =>
      candidate.desktopId === desktopId && candidate.label === label,
  );
  if (!window) throw new Error("native media window identity is not declared");
  return `Dure Native Media \u00b7 ${window.name} \u00b7 ${label} \u00b7 ${proof} \u00b7 ready-hit`;
}

export function nativeWindowReplayCompleteTitle({
  desktopId,
  label,
  proof,
  scenarioId = "workspace-overview",
}) {
  assertNativeWindowProof(proof);
  const window = scenarioWindows(scenarioId).find(
    (candidate) =>
      candidate.desktopId === desktopId && candidate.label === label,
  );
  if (!window) throw new Error("native media window identity is not declared");
  return `Dure Native Media \u00b7 ${window.name} \u00b7 ${label} \u00b7 ${proof} \u00b7 replay-complete`;
}

export function nativeWindowErrorTitle({
  label,
  proof,
  scenarioId = "workspace-overview",
}) {
  assertNativeWindowProof(proof);
  if (!scenarioWindows(scenarioId).some((window) => window.label === label)) {
    throw new Error("native media error window label is not declared");
  }
  return `Dure Native Media \u00b7 ${label} \u00b7 ${proof} \u00b7 error`;
}

export function nativeWindowPlan({ proof, scenarioId }) {
  assertNativeWindowProof(proof);
  return scenarioWindows(scenarioId).map((window) => {
    const query = new URLSearchParams({
      desktop: window.desktopId,
      label: window.label,
      proof,
      scenario: scenarioId,
      surface: window.surface,
    });
    if (window.agentId) {
      query.set("sessionWindow", window.agentId);
      query.set("sourceWindow", "main");
      query.set(
        "sourcePane",
        `${window.desktopId}:agent:${window.agentId}`,
      );
    }
    return {
      create: window.create,
      label: window.label,
      title: `Dure Native Media \u00b7 ${window.name} \u00b7 starting`,
      url: `tools/media-capture/native/window.html?${query.toString()}`,
      width: window.width,
      height: window.height,
      x: window.x,
      y: window.y,
      visible: true,
      focus: false,
      focusable: true,
      titleBarStyle: "Overlay",
      hiddenTitle: true,
      transparent: false,
    };
  });
}

export function nativeWindowDeclarations(scenarioId) {
  return scenarioWindows(scenarioId).map(
    ({ agentId, create, desktopId, label, surface }) => ({
      ...(agentId ? { agentId } : {}),
      create,
      desktopId,
      label,
      surface,
    }),
  );
}

export function assertNativeInteractionWindowRequest({
  label,
  options,
  scenarioId,
}) {
  const window = scenarioWindows(scenarioId).find(
    (candidate) => candidate.label === label && candidate.create === false,
  );
  if (!window?.agentId || options?.label !== label) {
    throw new Error("native media interaction window is not declared");
  }
  const requestedUrl = new URL(options.url, "http://dure.invalid/");
  const expectedPane = `${window.desktopId}:agent:${window.agentId}`;
  if (
    requestedUrl.origin !== "http://dure.invalid" ||
    requestedUrl.pathname !== "/index.html" ||
    requestedUrl.searchParams.size !== 3 ||
    requestedUrl.searchParams.get("sessionWindow") !== window.agentId ||
    requestedUrl.searchParams.get("sourceWindow") !== "main" ||
    requestedUrl.searchParams.get("sourcePane") !== expectedPane ||
    options.width !== window.width ||
    options.height !== window.height ||
    options.focus !== true
  ) {
    throw new Error("native media interaction window request is invalid");
  }
  return {
    agentId: window.agentId,
    desktopId: window.desktopId,
    label: window.label,
    surface: window.surface,
  };
}

export function expectedNativeWindowTitles(
  proof,
  scenarioId = "workspace-overview",
) {
  return expectedNativeWindowStateTitles(proof, scenarioId, (window) =>
    nativeWindowReadyTitle({
      desktopId: window.desktopId,
      label: window.label,
      proof,
      scenarioId,
    }),
  );
}

export function expectedNativeInitialWindowTitles(
  proof,
  scenarioId = "workspace-overview",
) {
  return expectedNativeWindowTitles(proof, scenarioId).filter(({ label }) =>
    scenarioWindows(scenarioId).some(
      (window) => window.label === label && window.create,
    ),
  );
}

function expectedNativeWindowStateTitles(proof, scenarioId, titleFor) {
  assertNativeWindowProof(proof);
  return scenarioWindows(scenarioId).map((window) => ({
    id: window.desktopId,
    desktopId: window.desktopId,
    label: window.label,
    surface: window.surface,
    title: titleFor(window),
  }));
}

export function expectedNativeWindowReplayTitles(
  proof,
  scenarioId = "workspace-overview",
) {
  return expectedNativeWindowStateTitles(proof, scenarioId, (window) =>
    nativeWindowReplayCompleteTitle({
      desktopId: window.desktopId,
      label: window.label,
      proof,
      scenarioId,
    }),
  );
}

export function expectedNativeWindowErrorTitles(
  proof,
  scenarioId = "workspace-overview",
) {
  return expectedNativeWindowStateTitles(proof, scenarioId, (window) =>
    nativeWindowErrorTitle({ label: window.label, proof, scenarioId }),
  );
}
