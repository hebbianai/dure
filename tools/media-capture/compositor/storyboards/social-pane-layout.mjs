export const SOCIAL_PANE_LAYOUT_STORYBOARD = {
  schemaVersion: 1,
  id: "social-pane-layout",
  title: "Wallpaper-framed agent pane layout",
  canvas: {
    width: 1920, height: 1080,
    safeArea: { top: 28, right: 64, bottom: 28, left: 64 },
    background: "#17243c",
  },
  sources: [{
    id: "layout", kind: "browser-capture", scenario: "social-pane-layout",
    artifact: "social-pane-layout.webm",
  }],
  shots: [
    ["beside", 0, 5000],
    ["stack", 5000, 10500],
    ["arranged", 10500, 15000],
  ].map(([id, start, end]) => ({
    id, sourceId: "layout", sourceStartMs: start, sourceEndMs: end,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    zoom: { from: 1, to: 1, anchor: { x: 0.5, y: 0.5 } },
    caption: {
      key: id, tone: "neutral", startMs: 0, endMs: end - start,
      rect: { x: 430, y: 34, width: 1060, height: 62 },
    },
  })),
  targets: [{
    id: "x", format: "mp4", codec: "h264", width: 1920, height: 1080,
    fps: 30, shotIds: ["beside", "stack", "arranged"],
  }],
  copy: { en: {
    beside: "Your agents. Your layout.",
    stack: "Side by side. Or stacked below.",
    arranged: "Dure · Put the work where you need it.",
  } },
  review: {
    privacyPolicy: "dure-public-media/v1",
    blankFrame: { blackRatio: 0.98, lumaThreshold: 16, maxConsecutiveFrames: 0 },
    perceptualDiff: {
      maxDistance: 0.08,
      keyframeProgress: [0, 0.07, 0.2, 0.3, 0.47, 0.6, 0.75, 0.95],
    },
  },
};
