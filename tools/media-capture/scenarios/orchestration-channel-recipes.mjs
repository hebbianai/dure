const ORCHESTRATION_CHANNEL_SEGMENTS = Object.freeze([
  Object.freeze({ startMs: 400, endMs: 1_000 }),
  Object.freeze({ startMs: 1_000, endMs: 8_600 }),
]);

export const ORCHESTRATION_CHANNEL_README_GIF = Object.freeze({
  schemaVersion: 1,
  segments: ORCHESTRATION_CHANNEL_SEGMENTS,
  fps: 10,
  width: 960,
  maxColors: 128,
  loop: 0,
});

export const ORCHESTRATION_CHANNEL_PUBLIC_WEBM = Object.freeze({
  schemaVersion: 1,
  segments: ORCHESTRATION_CHANNEL_SEGMENTS,
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
