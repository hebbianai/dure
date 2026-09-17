import {
  HEADLESS_SPAWN_PUBLIC_WEBM,
  HEADLESS_SPAWN_README_GIF,
} from "./headless-spawn-recipes.mjs";

const RECEIPT_ID = "sp_media_release_auditor_01";
const PROVIDER_SOURCE_SESSION_ID = "media-headless-codex-source";

export function createHeadlessSpawnScenario({ baseScenario }) {
  const fixture = structuredClone(baseScenario.fixture);
  fixture.activeDesktopId = "desk-launch";
  fixture.terminalSnapshots[PROVIDER_SOURCE_SESSION_ID] =
    fixture.terminalSnapshots["session-codex"];
  fixture.headlessSpawn = {
    schemaVersion: 1,
    receiptId: RECEIPT_ID,
    desktopId: "desk-launch",
    request: {
      project: "dure",
      name: "release-auditor",
      provider: "codex",
      runtime: "hmux",
      useWorktree: false,
    },
    providerTarget: {
      agentId: "media-headless-release-auditor",
      sessionId: PROVIDER_SOURCE_SESSION_ID,
      sessionKind: "pty",
      provider: "codex",
    },
  };
  return {
    ...baseScenario,
    id: "headless-spawn",
    title: "Headless agent spawn from the CLI",
    description:
      "A deterministic POST /spawn/v2 receipt drives the shipped spawn saga and opens a live Codex pane beside the calling terminal.",
    durationMs: 8_000,
    stillAtMs: 5_400,
    readmeGif: HEADLESS_SPAWN_README_GIF,
    publicWebm: HEADLESS_SPAWN_PUBLIC_WEBM,
    liveSessionTerminalSizes: { ...baseScenario.liveSessionTerminalSizes },
    fixture,
    setup: [{ action: "activateDesktop", desktopId: "desk-launch" }],
    timeline: [
      {
        atMs: 2_150,
        action: "headlessSpawn",
        desktopId: "desk-launch",
      },
    ],
  };
}
