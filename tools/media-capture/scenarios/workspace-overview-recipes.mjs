const WORKSPACE_OVERVIEW_SEGMENTS = Object.freeze([
  Object.freeze({ startMs: 1_200, endMs: 3_600 }),
  Object.freeze({ startMs: 5_000, endMs: 7_800 }),
  Object.freeze({ startMs: 9_600, endMs: 12_000 }),
  Object.freeze({ startMs: 12_800, endMs: 15_000 }),
]);

export const WORKSPACE_OVERVIEW_README_GIF = Object.freeze({
  schemaVersion: 1,
  segments: WORKSPACE_OVERVIEW_SEGMENTS,
  fps: 10,
  width: 960,
  maxColors: 128,
  loop: 0,
});

export const WORKSPACE_OVERVIEW_PUBLIC_WEBM = Object.freeze({
  schemaVersion: 1,
  segments: WORKSPACE_OVERVIEW_SEGMENTS,
  fps: 25,
  timeBase: "1/1000",
  width: 1920,
  codec: "vp9",
  crf: 34,
  pixelFormat: "yuv420p",
  bitrateKbps: 0,
  deadline: "good",
  cpuUsed: 2,
  rowMt: 0,
  threads: 1,
});
