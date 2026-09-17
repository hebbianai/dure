import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReviewEvidence } from "./review-evidence.mjs";
import {
  parseBlackFrameRecords,
  preflightTesseract,
  verifyRenderEvidence,
} from "./review-render.mjs";

const SHA = "a".repeat(64);

function reviewFixture() {
  const plan = {
    renderPlanSha256: "b".repeat(64),
    reviewRecipeSha256: "c".repeat(64),
    target: {
      codec: "vp8",
      width: 1_920,
      height: 1_080,
      fps: 25,
      durationInFrames: 3,
    },
    review: {
      keyframes: [0, 2],
      blankFrame: {
        blackRatio: 0.98,
        maxConsecutiveFrames: 0,
      },
      perceptualDiff: { maxDistance: 0.08 },
      privacyPolicy: "dure-public-media/v1",
    },
    canvas: { safeArea: { top: 1, right: 1, bottom: 1, left: 1 } },
  };
  const frames = [0, 2].map((frame) => ({
    frame,
    blackRatio: 0.1,
    perceptualHash: "0123456789abcdef",
    baselineHash: "0123456789abcdef",
    perceptualDistance: 0,
    detectedText: "Dure workspace",
  }));
  return {
    plan,
    frames,
    probe: {
      streams: [
        {
          codec_name: "vp8",
          width: 1_920,
          height: 1_080,
          r_frame_rate: "25/1",
          nb_read_frames: "3",
        },
      ],
    },
    blankFrameScan: { totalFrames: 3, frames: [] },
    privacyScan: {
      method: "tesseract-keyframes",
      scope: "declared-review-keyframes",
      inspectedFrames: 2,
      engine: {
        version: "tesseract 5.5.1",
        fingerprintSha256: SHA,
      },
    },
    artifactEvidence: { bytes: 123, sha256: SHA },
    renderEvidenceDigest: { bytes: 456, sha256: SHA },
  };
}

describe("storyboard review evidence", () => {
  it("binds review input to exact media and render-sidecar bytes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-review-proof-"));
    const mediaPath = resolve(root, "render.webm");
    const media = Buffer.from("rendered-media");
    const plan = { renderPlanSha256: "b".repeat(64) };
    try {
      await writeFile(mediaPath, media);
      await writeFile(
        `${mediaPath}.json`,
        JSON.stringify({
          schema: "dure-remotion-render-evidence/v1",
          renderPlanSha256: plan.renderPlanSha256,
          artifact: {
            bytes: media.length,
            sha256: createHash("sha256").update(media).digest("hex"),
          },
        }),
      );
      await expect(verifyRenderEvidence(plan, mediaPath)).resolves.toMatchObject({
        artifactEvidence: { bytes: media.length },
        sidecarEvidence: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      });
      await writeFile(mediaPath, "replaced-media");
      await expect(verifyRenderEvidence(plan, mediaPath)).rejects.toThrow(
        "rendered media bytes",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an ordered black-frame record for every probed frame", () => {
    expect(
      parseBlackFrameRecords(
        "frame:0 pblack:1.00\nframe:1 pblack:98.00\nframe:2 pblack:2.00",
        3,
        0.98,
      ),
    ).toEqual({ totalFrames: 3, frames: [1] });
    expect(() => parseBlackFrameRecords("", 3, 0.98)).toThrow(
      "produced 0 records",
    );
    expect(() =>
      parseBlackFrameRecords(
        "frame:0 pblack:1.00\nframe:2 pblack:2.00\nframe:1 pblack:3.00",
        3,
        0.98,
      ),
    ).toThrow("sequence is invalid");
  });

  it("fails closed when OCR, artifact, or render-sidecar evidence is empty", () => {
    const fixture = reviewFixture();
    expect(buildReviewEvidence(fixture)).toMatchObject({
      artifact: fixture.artifactEvidence,
      renderEvidence: fixture.renderEvidenceDigest,
    });
    expect(() =>
      buildReviewEvidence({
        ...fixture,
        frames: fixture.frames.map((frame, index) =>
          index === 0 ? { ...frame, detectedText: "" } : frame,
        ),
        artifactEvidence: undefined,
      }),
    ).toThrow(/artifact identity|empty OCR/u);
  });

  it("rejects an exit-zero program that is not Tesseract", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-fake-ocr-"));
    const fake = resolve(root, "fake-tesseract");
    try {
      await writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await expect(preflightTesseract(fake)).rejects.toThrow("OCR preflight");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
