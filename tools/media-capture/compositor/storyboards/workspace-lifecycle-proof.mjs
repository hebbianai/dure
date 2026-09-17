export const WORKSPACE_LIFECYCLE_PROOF_STORYBOARD = Object.freeze({
  schemaVersion: 1,
  id: "workspace-lifecycle-proof",
  title: "One workspace across view handoff, client reload, and stale recovery",
  canvas: {
    width: 1_920,
    height: 1_080,
    safeArea: { top: 64, right: 96, bottom: 80, left: 96 },
    background: "#181818",
  },
  sources: [
    {
      id: "view-handoff",
      kind: "native-selection",
      scenario: "hmux-multiple-views",
      artifact: "hmux-multiple-views.webm",
      proofProfile: "hmux-native-view-handoff-v1",
    },
    {
      id: "client-reconnect",
      kind: "browser-capture",
      scenario: "hmux-app-reconnect",
      artifact: "hmux-app-reconnect.webm",
      proofProfile: "hmux-client-reconnect-v1",
    },
    {
      id: "reboot-stale-recovery",
      kind: "browser-capture",
      scenario: "session-recovery",
      artifact: "session-recovery.webm",
      proofProfile: "hmux-reboot-stale-recovery-v1",
    },
  ],
  shots: [
    {
      id: "handoff-proof",
      sourceId: "view-handoff",
      sourceStartMs: 0,
      sourceEndMs: 13_000,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1, to: 1.04, anchor: { x: 0.62, y: 0.48 } },
      caption: {
        key: "handoff-caption",
        tone: "observed",
        startMs: 400,
        endMs: 12_800,
        rect: { x: 96, y: 900, width: 1_728, height: 100 },
      },
      callouts: [
        {
          key: "handoff-limit",
          startMs: 1_600,
          endMs: 12_000,
          target: { x: 0.51, y: 0.08, width: 0.47, height: 0.74 },
          labelRect: { x: 96, y: 780, width: 960, height: 100 },
        },
      ],
    },
    {
      id: "reconnect-proof",
      sourceId: "client-reconnect",
      sourceStartMs: 0,
      sourceEndMs: 10_800,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1.04, to: 1, anchor: { x: 0.53, y: 0.5 } },
      caption: {
        key: "reconnect-caption",
        tone: "observed",
        startMs: 300,
        endMs: 10_600,
        rect: { x: 96, y: 900, width: 1_728, height: 100 },
      },
      callouts: [
        {
          key: "reconnect-limit",
          startMs: 1_400,
          endMs: 10_000,
          target: { x: 0.205, y: 0.16, width: 0.38, height: 0.34 },
          labelRect: { x: 864, y: 780, width: 960, height: 100 },
        },
      ],
    },
    {
      id: "recovery-proof",
      sourceId: "reboot-stale-recovery",
      sourceStartMs: 0,
      sourceEndMs: 12_000,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1, to: 1.05, anchor: { x: 0.55, y: 0.5 } },
      caption: {
        key: "recovery-caption",
        tone: "observed",
        startMs: 300,
        endMs: 11_800,
        rect: { x: 96, y: 900, width: 1_728, height: 100 },
      },
      callouts: [
        {
          key: "recovery-limit",
          startMs: 1_400,
          endMs: 11_200,
          target: { x: 0.055, y: 0.105, width: 0.15, height: 0.16 },
          labelRect: { x: 96, y: 780, width: 1_180, height: 100 },
        },
      ],
    },
    {
      id: "handoff-replay",
      sourceId: "view-handoff",
      sourceStartMs: 3_000,
      sourceEndMs: 13_000,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1.04, to: 1.12, anchor: { x: 0.7, y: 0.47 } },
      caption: {
        key: "handoff-replay-caption",
        tone: "replay",
        startMs: 200,
        endMs: 9_800,
        rect: { x: 96, y: 900, width: 1_728, height: 100 },
      },
    },
    {
      id: "reconnect-replay",
      sourceId: "client-reconnect",
      sourceStartMs: 2_000,
      sourceEndMs: 9_000,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1.1, to: 1.04, anchor: { x: 0.55, y: 0.5 } },
      caption: {
        key: "reconnect-replay-caption",
        tone: "replay",
        startMs: 200,
        endMs: 6_800,
        rect: { x: 96, y: 900, width: 1_728, height: 100 },
      },
    },
    {
      id: "recovery-replay",
      sourceId: "reboot-stale-recovery",
      sourceStartMs: 3_000,
      sourceEndMs: 11_000,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1.04, to: 1, anchor: { x: 0.55, y: 0.5 } },
      caption: {
        key: "recovery-replay-caption",
        tone: "replay",
        startMs: 200,
        endMs: 7_800,
        rect: { x: 96, y: 900, width: 1_728, height: 100 },
      },
    },
  ],
  targets: [
    {
      id: "launch",
      format: "mp4",
      codec: "h264",
      width: 1_920,
      height: 1_080,
      fps: 25,
      shotIds: [
        "handoff-proof",
        "reconnect-proof",
        "recovery-proof",
        "reconnect-replay",
        "recovery-replay",
        "handoff-replay",
      ],
    },
    {
      id: "flagship",
      format: "mp4",
      codec: "h264",
      width: 1_920,
      height: 1_080,
      fps: 25,
      shotIds: ["handoff-proof", "handoff-replay"],
    },
  ],
  copy: {
    en: {
      "handoff-caption":
        "View handoff survived — the same live agent session crossed two real Tauri windows.",
      "handoff-limit":
        "Current limit — native app restart and machine reboot were not observed.",
      "reconnect-caption":
        "Client reload reattached — the exact live session generation stayed authoritative.",
      "reconnect-limit":
        "Current limit — this does not observe native app process exit or restart.",
      "recovery-caption":
        "Reboot-stale session recovered — confirmation replayed its saved presentation checkpoint.",
      "recovery-limit":
        "Fixture evidence — no machine reboot, native restart, network disconnect, or host crash was observed.",
      "handoff-replay-caption":
        "Replay — Run this workflow with two agents.",
      "reconnect-replay-caption":
        "Replay — the live client returned to the same session generation.",
      "recovery-replay-caption":
        "Replay — the saved presentation checkpoint restored a usable session.",
    },
  },
  review: {
    privacyPolicy: "dure-public-media/v1",
    blankFrame: {
      blackRatio: 0.98,
      lumaThreshold: 16,
      maxConsecutiveFrames: 0,
    },
    perceptualDiff: {
      maxDistance: 0.08,
      keyframeProgress: [0, 0.18, 0.36, 0.54, 0.72, 0.88, 0.98],
    },
  },
});
