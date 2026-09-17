import { PRODUCT_TOUR_CLIPS } from "../../scenarios/product-tour.mjs";

export const PRODUCT_TOUR_STORYBOARD = {
  schemaVersion: 1,
  id: "product-tour",
  title: "Six guided Dure workflows",
  canvas: { width: 2960, height: 1880, safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, background: "#101114" },
  sources: PRODUCT_TOUR_CLIPS.map(({ id }) => ({ id, kind: "browser-capture", scenario: `tour-${id}`, artifact: `tour-${id}.webm` })),
  shots: PRODUCT_TOUR_CLIPS.map(({ id, durationMs }) => ({
    id, sourceId: id, sourceStartMs: 0, sourceEndMs: durationMs,
    crop: { x: 0, y: 0, width: 1, height: 1 }, zoom: { from: 1, to: 1, anchor: { x: .5, y: .5 } },
  })),
  targets: PRODUCT_TOUR_CLIPS.map(({ id }) => ({ id, format: "mp4", codec: "h264", width: 2960, height: 1880, fps: 60, shotIds: [id] })),
  copy: { en: {} },
  review: {
    privacyPolicy: "dure-public-media/v1",
    blankFrame: { blackRatio: .98, lumaThreshold: 16, maxConsecutiveFrames: 0 },
    perceptualDiff: { maxDistance: .08, keyframeProgress: [0, .2, .4, .6, .8, .95] },
  },
};
