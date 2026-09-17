export const ONBOARDING_LAUNCH_STORYBOARD = Object.freeze({
  schemaVersion: 1,
  id: "onboarding-launch",
  title: "From recent work to a parallel workspace",
  canvas: {
    width: 1_920,
    height: 1_080,
    safeArea: { top: 72, right: 96, bottom: 88, left: 96 },
    background: "#181818",
  },
  sources: [
    {
      id: "onboarding",
      kind: "browser-capture",
      scenario: "onboarding-walkthrough",
      artifact: "onboarding-walkthrough.webm",
    },
  ],
  shots: [
    {
      id: "discover",
      sourceId: "onboarding",
      sourceStartMs: 600,
      sourceEndMs: 6_200,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1, to: 1, anchor: { x: 0.34, y: 0.45 } },
      caption: {
        key: "discover-caption",
        startMs: 400,
        endMs: 5_600,
        rect: { x: 120, y: 900, width: 1_680, height: 80 },
      },
      callouts: [
        {
          key: "discover-callout",
          startMs: 900,
          endMs: 3_900,
          target: { x: 0.195, y: 0.105, width: 0.3, height: 0.72 },
          labelRect: { x: 1_160, y: 128, width: 600, height: 72 },
        },
      ],
    },
    {
      id: "parallel",
      sourceId: "onboarding",
      sourceStartMs: 12_000,
      sourceEndMs: 17_000,
      crop: { x: 0, y: 0, width: 1, height: 1 },
      zoom: { from: 1, to: 1, anchor: { x: 0.66, y: 0.5 } },
      caption: {
        key: "parallel-caption",
        startMs: 240,
        endMs: 5_000,
        rect: { x: 120, y: 900, width: 1_680, height: 80 },
      },
      callouts: [
        {
          key: "parallel-callout",
          startMs: 700,
          endMs: 5_000,
          target: { x: 0.722, y: 0.55, width: 0.27, height: 0.25 },
          labelRect: { x: 120, y: 128, width: 620, height: 72 },
        },
      ],
    },
  ],
  targets: [
    {
      id: "readme",
      format: "gif",
      codec: "gif",
      width: 960,
      height: 540,
      fps: 12,
      shotIds: ["discover"],
    },
    {
      id: "mintlify",
      format: "webm",
      codec: "vp8",
      width: 1_920,
      height: 1_080,
      fps: 25,
      shotIds: ["discover", "parallel"],
    },
    {
      id: "launch",
      format: "mp4",
      codec: "h264",
      width: 1_920,
      height: 1_080,
      fps: 30,
      shotIds: ["discover", "parallel"],
    },
  ],
  copy: {
    en: {
      "discover-caption": "Start with the work already in progress.",
      "discover-callout": "Review recent local and SSH sessions before anything launches.",
      "parallel-caption": "Confirm once. Continue in a focused parallel workspace.",
      "parallel-callout": "Local Codex, Claude Code, and an SSH agent share one workspace.",
    },
    ko: {
      "discover-caption": "이미 진행 중인 작업에서 바로 시작하세요.",
      "discover-callout": "실행 전에 최근 로컬·SSH 세션을 검토합니다.",
      "parallel-caption": "한 번 확인하고 집중된 병렬 workspace에서 이어갑니다.",
      "parallel-callout": "로컬 Codex·Claude Code와 SSH 에이전트를 한곳에서 봅니다.",
    },
    zh: {
      "discover-caption": "直接从正在进行的工作开始。",
      "discover-callout": "启动前先检查近期的本地与 SSH 会话。",
      "parallel-caption": "确认一次，即可在专注的并行工作区继续。",
      "parallel-callout": "本地 Codex、Claude Code 与 SSH 代理共用一个工作区。",
    },
    ja: {
      "discover-caption": "進行中の作業から、そのまま始められます。",
      "discover-callout": "起動前に最近のローカル・SSH セッションを確認します。",
      "parallel-caption": "一度確認すれば、並列ワークスペースで続行できます。",
      "parallel-callout": "Codex、Claude Code、SSH エージェントを一つの画面で扱えます。",
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
      keyframeProgress: [0, 0.25, 0.48, 0.75, 0.94],
    },
  },
});
