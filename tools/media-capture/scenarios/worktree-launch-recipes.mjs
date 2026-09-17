const WORKTREE_LAUNCH_SEGMENTS = Object.freeze([
  Object.freeze({ startMs: 400, endMs: 2_200 }),
  Object.freeze({ startMs: 2_200, endMs: 8_600 }),
]);

export const WORKTREE_LAUNCH_README_GIF = Object.freeze({
  schemaVersion: 1,
  segments: WORKTREE_LAUNCH_SEGMENTS,
  fps: 10,
  width: 960,
  maxColors: 128,
  loop: 0,
});

export const WORKTREE_LAUNCH_PUBLIC_WEBM = Object.freeze({
  schemaVersion: 1,
  segments: WORKTREE_LAUNCH_SEGMENTS,
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
