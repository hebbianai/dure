const HEADLESS_SPAWN_SEGMENTS = Object.freeze([
  Object.freeze({ startMs: 600, endMs: 2_200 }),
  Object.freeze({ startMs: 2_200, endMs: 8_000 }),
]);

export const HEADLESS_SPAWN_README_GIF = Object.freeze({
  schemaVersion: 1,
  segments: HEADLESS_SPAWN_SEGMENTS,
  fps: 10,
  width: 960,
  maxColors: 128,
  loop: 0,
});

export const HEADLESS_SPAWN_PUBLIC_WEBM = Object.freeze({
  schemaVersion: 1,
  segments: HEADLESS_SPAWN_SEGMENTS,
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
