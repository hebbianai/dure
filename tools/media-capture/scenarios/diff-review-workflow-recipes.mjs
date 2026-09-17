const DIFF_REVIEW_WORKFLOW_SEGMENTS = Object.freeze([
  Object.freeze({ startMs: 200, endMs: 1_200 }),
  Object.freeze({ startMs: 1_200, endMs: 7_000 }),
]);

export const DIFF_REVIEW_WORKFLOW_README_GIF = Object.freeze({
  schemaVersion: 1,
  segments: DIFF_REVIEW_WORKFLOW_SEGMENTS,
  fps: 10,
  width: 960,
  maxColors: 128,
  loop: 0,
});

export const DIFF_REVIEW_WORKFLOW_PUBLIC_WEBM = Object.freeze({
  schemaVersion: 1,
  segments: DIFF_REVIEW_WORKFLOW_SEGMENTS,
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
