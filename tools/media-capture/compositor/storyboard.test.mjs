import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { writeJsonAtomically } from "../atomic-json.mjs";
import { listStoryboards } from "../storyboard.mjs";
import { runStoryboardReview } from "../review-storyboard.mjs";
import { MEDIA_STORYBOARDS } from "./catalog.mjs";
import {
  defaultStoryboardOutputRoot,
  parseStoryboardArgs,
} from "./cli.mjs";
import { compileStoryboard } from "./compile.mjs";
import {
  blackPixelRatio,
  differenceHashFromGrayFrame,
  normalizedHashDistance,
  reviewFrameRecord,
} from "./frame-analysis.mjs";
import { storyboardOutputPaths } from "./output.mjs";
import { remotionPropsFromRenderPlan } from "./remotion-props.mjs";
import { absoluteRectStyle } from "./remotion/src/layout.mjs";
import { verifyRenderSources } from "./render-sources.mjs";
import {
  reviewBaselineCandidate,
  validateReviewBaseline,
} from "./review-baseline.mjs";
import { buildReviewEvidence } from "./review-evidence.mjs";
import { validateStoryboard } from "./schema.mjs";
import { ONBOARDING_LAUNCH_STORYBOARD } from "./storyboards/onboarding-launch.mjs";
import { WORKSPACE_OVERVIEW_TOUR_STORYBOARD } from "./storyboards/workspace-overview-tour.mjs";
import { WORKSPACE_LIFECYCLE_PROOF_STORYBOARD } from "./storyboards/workspace-lifecycle-proof.mjs";
import { SOCIAL_PANE_LAYOUT_STORYBOARD } from "./storyboards/social-pane-layout.mjs";

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createCaptureFixture({
  dirty = false,
  durationMs = 17_000,
  mediaDurationMs = 17_680,
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "dure-storyboard-test-"));
  const scenarioDirectory = resolve(root, "media", "onboarding-walkthrough");
  const artifactPath = resolve(
    scenarioDirectory,
    "onboarding-walkthrough.webm",
  );
  await mkdir(scenarioDirectory, { recursive: true });
  await writeFile(artifactPath, "canonical-capture");
  const bytes = (await readFile(artifactPath)).length;
  await writeFile(
    resolve(scenarioDirectory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 4,
      scenario: "onboarding-walkthrough",
      applicationBuild: {
        buildId: "0.1.4+0123456789ab",
        packageVersion: "0.1.4",
        sourceRevision: "0123456789ab",
        dirty,
      },
      recording: { requestedDurationMs: durationMs },
      artifacts: [
        {
          path: "output/playwright/media/onboarding-walkthrough/onboarding-walkthrough.webm",
          bytes,
          sha256: await sha256(artifactPath),
        },
      ],
      terminalGeometry: { webm: {} },
    }),
  );
  return {
    root,
    artifactPath,
    probeSourceMedia: async () => ({
      codec: "vp8",
      width: 1_920,
      height: 1_080,
      pixelFormat: "yuv420p",
      frameRate: "25/1",
      frameCount: Math.round((mediaDurationMs * 25) / 1_000),
      durationMs: mediaDurationMs,
    }),
  };
}

async function compileFixture(options = {}) {
  const fixture = await createCaptureFixture(options);
  const plan = await compileStoryboard({
    storyboard: ONBOARDING_LAUNCH_STORYBOARD,
    locale: "en",
    targetId: "mintlify",
    captureRoot: fixture.root,
    captureTrustRoot: fixture.root,
    captureBoundary: fixture.root,
    probeSourceMedia: fixture.probeSourceMedia,
  });
  return { ...fixture, plan };
}

describe("product media storyboard compositor", () => {
  it("keeps a versioned, localized, engine-neutral storyboard catalog", () => {
    expect(MEDIA_STORYBOARDS).toHaveLength(5);
    expect(validateStoryboard(SOCIAL_PANE_LAYOUT_STORYBOARD)).toEqual([]);
    expect(validateStoryboard(ONBOARDING_LAUNCH_STORYBOARD)).toEqual([]);
    expect(validateStoryboard(WORKSPACE_OVERVIEW_TOUR_STORYBOARD)).toEqual([]);
    expect(validateStoryboard(WORKSPACE_LIFECYCLE_PROOF_STORYBOARD)).toEqual([]);
    expect(listStoryboards()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "onboarding-launch",
          locales: ["en", "ko", "zh", "ja"],
        }),
        expect.objectContaining({
          id: "workspace-overview-tour",
          locales: ["en", "ko", "zh", "ja"],
        }),
        expect.objectContaining({
          id: "workspace-lifecycle-proof",
          locales: ["en"],
        }),
      ]),
    );
    const proofTarget = WORKSPACE_LIFECYCLE_PROOF_STORYBOARD.targets[0];
    const proofShots = new Map(
      WORKSPACE_LIFECYCLE_PROOF_STORYBOARD.shots.map((shot) => [shot.id, shot]),
    );
    const targetDurationMs = (target) =>
      target.shotIds.reduce((durationMs, shotId) => {
        const shot = proofShots.get(shotId);
        return durationMs + shot.sourceEndMs - shot.sourceStartMs;
      }, 0);
    expect(targetDurationMs(proofTarget)).toBe(60_800);
    const flagshipTarget = WORKSPACE_LIFECYCLE_PROOF_STORYBOARD.targets.find(
      ({ id }) => id === "flagship",
    );
    expect(targetDurationMs(flagshipTarget)).toBe(23_000);
  });

  it("compiles verified canonical captures into stable target timelines", async () => {
    const { root, plan } = await compileFixture();
    try {
      expect(plan).toMatchObject({
        schema: "dure-storyboard-render-plan/v1",
        locale: "en",
        target: {
          id: "mintlify",
          format: "webm",
          codec: "vp8",
          width: 1_920,
          height: 1_080,
          fps: 25,
          durationInFrames: 265,
        },
      });
      expect(plan.shots.map(({ durationInFrames }) => durationInFrames)).toEqual([
        140, 125,
      ]);
      expect(plan.review.keyframes).toEqual([0, 66, 127, 198, 248]);
      expect(plan.sources[0]).toMatchObject({
        capturePath: "media/onboarding-walkthrough/onboarding-walkthrough.webm",
        durationMs: 17_680,
      });
      expect(JSON.stringify(plan)).not.toContain(root);
      expect(
        await compileStoryboard({
          storyboard: ONBOARDING_LAUNCH_STORYBOARD,
          locale: "en",
          targetId: "mintlify",
          captureRoot: root,
          captureTrustRoot: root,
          captureBoundary: root,
          probeSourceMedia: async () => ({
            codec: "vp8",
            width: 1_920,
            height: 1_080,
            pixelFormat: "yuv420p",
            frameRate: "25/1",
            frameCount: 442,
            durationMs: 17_680,
          }),
        }),
      ).toEqual(plan);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compiles README and launch frame counts without changing shot timing", async () => {
    const fixture = await createCaptureFixture();
    try {
      const readme = await compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "ko",
        targetId: "readme",
        captureRoot: fixture.root,
        captureTrustRoot: fixture.root,
        captureBoundary: fixture.root,
        probeSourceMedia: fixture.probeSourceMedia,
      });
      const launch = await compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "ja",
        targetId: "launch",
        captureRoot: fixture.root,
        captureTrustRoot: fixture.root,
        captureBoundary: fixture.root,
        probeSourceMedia: fixture.probeSourceMedia,
      });
      expect(readme.target.durationInFrames).toBe(67);
      expect(readme.shots[0].caption.text).toContain("시작");
      expect(launch.target.durationInFrames).toBe(318);
      expect(launch.shots[1].callouts[0].text).toContain("SSH");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps zero source and overlay timestamps on frame zero", async () => {
    const fixture = await createCaptureFixture();
    const storyboard = structuredClone(ONBOARDING_LAUNCH_STORYBOARD);
    storyboard.shots[0].sourceStartMs = 0;
    storyboard.shots[0].caption.startMs = 0;
    storyboard.shots[0].caption.tone = "observed";
    try {
      const plan = await compileStoryboard({
        storyboard,
        locale: "en",
        targetId: "readme",
        captureRoot: fixture.root,
        captureTrustRoot: fixture.root,
        captureBoundary: fixture.root,
        probeSourceMedia: fixture.probeSourceMedia,
      });
      expect(plan.shots[0].sourceStartFrame).toBe(0);
      expect(plan.shots[0].caption.startFrame).toBe(0);
      expect(plan.shots[0].caption.tone).toBe("observed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed on dirty, tampered, escaped, and too-short capture sources", async () => {
    const dirty = await createCaptureFixture({ dirty: true });
    await expect(
      compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "en",
        targetId: "readme",
        captureRoot: dirty.root,
        captureTrustRoot: dirty.root,
        captureBoundary: dirty.root,
        probeSourceMedia: dirty.probeSourceMedia,
      }),
    ).rejects.toThrow("clean build");
    await rm(dirty.root, { recursive: true, force: true });

    const tampered = await createCaptureFixture();
    await writeFile(tampered.artifactPath, "tampered");
    await expect(
      compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "en",
        targetId: "readme",
        captureRoot: tampered.root,
        captureTrustRoot: tampered.root,
        captureBoundary: tampered.root,
        probeSourceMedia: tampered.probeSourceMedia,
      }),
    ).rejects.toThrow("bytes do not match");
    await rm(tampered.root, { recursive: true, force: true });

    const tooShort = await createCaptureFixture({
      durationMs: 16_000,
      mediaDurationMs: 16_000,
    });
    await expect(
      compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "en",
        targetId: "mintlify",
        captureRoot: tooShort.root,
        captureTrustRoot: tooShort.root,
        captureBoundary: tooShort.root,
        probeSourceMedia: tooShort.probeSourceMedia,
      }),
    ).rejects.toThrow("ends after source");
    await rm(tooShort.root, { recursive: true, force: true });

    const escaped = await createCaptureFixture();
    const outside = resolve(await mkdtemp(resolve(tmpdir(), "dure-source-")), "outside.webm");
    await writeFile(outside, "canonical-capture");
    await rm(escaped.artifactPath);
    await symlink(outside, escaped.artifactPath);
    await expect(
      compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "en",
        targetId: "readme",
        captureRoot: escaped.root,
        captureTrustRoot: escaped.root,
        captureBoundary: escaped.root,
        probeSourceMedia: escaped.probeSourceMedia,
      }),
    ).rejects.toThrow("escapes the capture root");
    await rm(resolve(outside, ".."), { recursive: true, force: true });
    await rm(escaped.root, { recursive: true, force: true });

    const linkedRootFixture = await createCaptureFixture();
    const trustRoot = await mkdtemp(resolve(tmpdir(), "dure-capture-trust-"));
    const linkedRoot = resolve(trustRoot, "linked-capture");
    await symlink(linkedRootFixture.root, linkedRoot);
    await expect(
      compileStoryboard({
        storyboard: ONBOARDING_LAUNCH_STORYBOARD,
        locale: "en",
        targetId: "readme",
        captureRoot: linkedRoot,
        captureTrustRoot: trustRoot,
        captureBoundary: trustRoot,
        probeSourceMedia: linkedRootFixture.probeSourceMedia,
      }),
    ).rejects.toThrow("symbolic link");
    await rm(trustRoot, { recursive: true, force: true });
    await rm(linkedRootFixture.root, { recursive: true, force: true });
  });

  it("rejects unsafe storyboard geometry, targets, copy, and public text", () => {
    const invalid = structuredClone(ONBOARDING_LAUNCH_STORYBOARD);
    invalid.canvas.safeArea.left = invalid.canvas.width;
    invalid.targets[0].width = 1_000;
    invalid.targets[0].shotIds = [];
    invalid.copy.en["discover-caption"] = "/Users/example/private";
    invalid.shots[0].caption.tone = "decorative";
    invalid.review.perceptualDiff.keyframeProgress = [0, 0, 1.1];
    expect(validateStoryboard(invalid)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("horizontal content space"),
        expect.stringContaining("aspect ratio"),
        expect.stringContaining("at least one shot"),
        expect.stringContaining("keyframeProgress"),
        expect.stringContaining("forbidden public text"),
        expect.stringContaining("invalid tone"),
      ]),
    );
  });

  it("keeps the Remotion adapter target-specific and source-relative", async () => {
    const { root, plan } = await compileFixture();
    try {
      expect(remotionPropsFromRenderPlan(plan)).toMatchObject({
        schema: "dure-remotion-props/v1",
        compositionId: "DureStoryboard",
        width: 1_920,
        height: 1_080,
        fps: 25,
        durationInFrames: 265,
        inputProps: {
          sources: [
            {
              capturePath:
                "media/onboarding-walkthrough/onboarding-walkthrough.webm",
              bytes: 17,
            },
          ],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks canonical source identity at the renderer boundary", async () => {
    const { root, artifactPath, plan } = await compileFixture();
    const sources = remotionPropsFromRenderPlan(plan).inputProps.sources;
    try {
      await expect(
        verifyRenderSources({ sources, captureRoot: root }),
      ).resolves.toEqual([
        expect.objectContaining({ id: "onboarding", bytes: 17 }),
      ]);
      await writeFile(artifactPath, "changed-after-compile");
      await expect(
        verifyRenderSources({ sources, captureRoot: root }),
      ).rejects.toThrow("changed after compilation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps storyboard x/y coordinates onto absolute CSS geometry", () => {
    expect(
      absoluteRectStyle({ x: 120, y: 900, width: 1_680, height: 80 }),
    ).toEqual({ left: 120, top: 900, width: 1_680, height: 80 });
  });

  it("parses explicit compile and render commands below ignored output", () => {
    expect(
      parseStoryboardArgs([
        "--storyboard",
        "onboarding-launch",
        "--target",
        "mintlify",
        "--render",
      ]),
    ).toMatchObject({
      storyboardId: "onboarding-launch",
      targetId: "mintlify",
      locale: "en",
      outputRoot: defaultStoryboardOutputRoot,
      render: true,
    });
    expect(() => parseStoryboardArgs(["--storyboard", "onboarding-launch"])).toThrow(
      "--target is required",
    );
    expect(() => parseStoryboardArgs(["--unknown"])).toThrow("unknown argument");
  });

  it("rejects unknown review locales before resolving output paths", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-review-locale-"));
    try {
      await expect(
        runStoryboardReview({
          storyboardId: "onboarding-launch",
          targetId: "mintlify",
          locale: "x/../../escape",
          outputRoot: root,
          baselineRoot: root,
          ocr: false,
        }),
      ).rejects.toThrow("unknown locale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically removes stale pass evidence when a new review fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-review-failure-"));
    const targetDirectory = resolve(
      root,
      "onboarding-launch",
      "en",
      "mintlify",
    );
    const stem = "onboarding-launch.en.mintlify";
    try {
      await mkdir(resolve(targetDirectory, "review"), { recursive: true });
      await Promise.all([
        writeFile(resolve(targetDirectory, `${stem}.render-plan.json`), "{}\n"),
        writeFile(resolve(targetDirectory, `${stem}.webm`), "media"),
        writeFile(resolve(targetDirectory, `${stem}.webm.json`), "{}\n"),
        writeFile(
          resolve(targetDirectory, "review", "review-evidence.json"),
          "stale pass\n",
        ),
      ]);
      await expect(
        runStoryboardReview(
          {
            storyboardId: "onboarding-launch",
            targetId: "mintlify",
            locale: "en",
            outputRoot: root,
            baselineRoot: root,
            ocr: false,
          },
          {
            allowedRoot: root,
            analyzeRender: async () => {
              throw new Error("review failed");
            },
          },
        ),
      ).rejects.toThrow("review failed");
      expect(await readFile(resolve(targetDirectory, `${stem}.webm`), "utf8")).toBe(
        "media",
      );
      await expect(
        readFile(resolve(targetDirectory, "review", "review-evidence.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes render plans atomically into target-specific directories", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dure-storyboard-output-"));
    try {
      const paths = storyboardOutputPaths({
        outputRoot: root,
        storyboardId: "onboarding-launch",
        locale: "en",
        target: { id: "readme", format: "gif" },
      });
      await writeJsonAtomically(paths.plan, { schema: "test" }, {
        allowedRoot: root,
      });
      expect(JSON.parse(await readFile(paths.plan, "utf8"))).toEqual({
        schema: "test",
      });
      expect(() =>
        storyboardOutputPaths({
          outputRoot: root,
          storyboardId: "..",
          locale: "outside",
          target: { id: "readme", format: "gif" },
        }),
      ).toThrow("safe path segment");
      expect(() =>
        storyboardOutputPaths({
          outputRoot: root,
          storyboardId: "onboarding-launch",
          locale: "x/../../escape",
          target: { id: "readme", format: "gif" },
        }),
      ).toThrow("safe path segment");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds deterministic dHash and blank-frame review evidence", () => {
    const gray = new Uint8Array(9 * 8);
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 9; column += 1) {
        gray[row * 9 + column] = column * 20;
      }
    }
    const hash = differenceHashFromGrayFrame(gray, 9, 8);
    expect(hash).toBe("0000000000000000");
    expect(normalizedHashDistance(hash, "ffffffffffffffff")).toBe(1);
    expect(blackPixelRatio(gray, 20)).toBeCloseTo(2 / 9);
    expect(
      reviewFrameRecord({
        frame: 0,
        grayFrame: gray,
        width: 9,
        height: 8,
        lumaThreshold: 20,
        baselineHash: hash,
      }),
    ).toMatchObject({
      frame: 0,
      perceptualHash: hash,
      baselineHash: hash,
      perceptualDistance: 0,
    });
  });

  it("requires full probes, approved perceptual baselines, and privacy-safe OCR", async () => {
    const { root, plan } = await compileFixture();
    try {
      const baselineHash = "0123456789abcdef";
      const frames = plan.review.keyframes.map((frame) => ({
        frame,
        blackRatio: 0.1,
        perceptualHash: baselineHash,
        baselineHash,
        perceptualDistance: 0,
        detectedText: "Dure workspace",
      }));
      const probe = {
        streams: [
          {
            codec_name: "vp8",
            width: 1_920,
            height: 1_080,
            r_frame_rate: "25/1",
            nb_read_frames: "265",
          },
        ],
      };
      const evidence = buildReviewEvidence({
        plan,
        probe,
        blankFrameScan: { totalFrames: 265, frames: [] },
        privacyScan: {
          method: "tesseract-keyframes",
          scope: "declared-review-keyframes",
          inspectedFrames: 5,
          engine: {
            version: "tesseract 5.5.1",
            fingerprintSha256: "a".repeat(64),
          },
        },
        frames,
        artifactEvidence: { bytes: 123, sha256: "b".repeat(64) },
        renderEvidenceDigest: { bytes: 456, sha256: "c".repeat(64) },
      });
      expect(evidence).toMatchObject({
        schema: "dure-storyboard-review-evidence/v1",
        blankFrameScan: { totalFrames: 265, longestConsecutiveRun: 0 },
      });
      expect(evidence.keyframes[0]).not.toHaveProperty("detectedText");
      expect(evidence.keyframes[0].ocr).toMatchObject({
        characters: 14,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      const candidate = reviewBaselineCandidate(plan, frames);
      expect(validateReviewBaseline(candidate, plan)).toEqual([]);
      expect(
        validateReviewBaseline(
          { ...candidate, reviewRecipeSha256: "d".repeat(64) },
          plan,
        ),
      ).toContain("review baseline recipe does not match");
      expect(
        validateReviewBaseline(
          {
            ...candidate,
            sourceArtifacts: candidate.sourceArtifacts.map((source) => ({
              ...source,
              sha256: "e".repeat(64),
            })),
          },
          plan,
        ),
      ).toContain("review baseline source artifacts do not match");
      expect(() =>
        buildReviewEvidence({
          plan,
          probe,
          blankFrameScan: { totalFrames: 264, frames: [8] },
          privacyScan: {
            method: "tesseract-keyframes",
            scope: "declared-review-keyframes",
            inspectedFrames: 5,
            engine: {
              version: "tesseract 5.5.1",
              fingerprintSha256: "a".repeat(64),
            },
          },
          frames: frames.map((frame, index) =>
            index === 0
              ? { ...frame, baselineHash: null, detectedText: "localhost:1420" }
              : frame,
          ),
          artifactEvidence: { bytes: 123, sha256: "b".repeat(64) },
          renderEvidenceDigest: { bytes: 456, sha256: "c".repeat(64) },
        }),
      ).toThrow(/did not inspect every|no approved baseline|forbidden public text/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
