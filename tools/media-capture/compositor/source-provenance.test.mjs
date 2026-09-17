import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileStoryboard } from "./compile.mjs";
import { canonicalSourceMediaFromProbe } from "./source-media.mjs";
import { ONBOARDING_LAUNCH_STORYBOARD } from "./storyboards/onboarding-launch.mjs";
import { WORKSPACE_LIFECYCLE_PROOF_STORYBOARD } from "./storyboards/workspace-lifecycle-proof.mjs";
import { verifiedNativeSourceSelection } from "../native/selected-source.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const SOURCE_MEDIA = Object.freeze({
  codec: "vp8",
  width: 1_920,
  height: 1_080,
  pixelFormat: "yuv420p",
  frameRate: "25/1",
  frameCount: 442,
  durationMs: 17_680,
});

async function createFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dure-source-provenance-"));
  const scenarioDirectory = resolve(root, "media", "onboarding-walkthrough");
  await mkdir(scenarioDirectory, { recursive: true });
  const artifactPath = resolve(
    scenarioDirectory,
    "onboarding-walkthrough.webm",
  );
  const artifactBytes = Buffer.from("canonical-source-bytes");
  await writeFile(artifactPath, artifactBytes);
  const manifest = {
    schemaVersion: 4,
    scenario: "onboarding-walkthrough",
    applicationBuild: {
      buildId: "0.1.4+0123456789ab",
      packageVersion: "0.1.4",
      sourceRevision: "0123456789ab",
      dirty: false,
    },
    recording: { requestedDurationMs: 17_000 },
    artifacts: [
      {
        path: "output/playwright/media/onboarding-walkthrough/onboarding-walkthrough.webm",
        bytes: artifactBytes.length,
        sha256: sha256(artifactBytes),
      },
    ],
    terminalGeometry: { webm: {} },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = resolve(scenarioDirectory, "manifest.json");
  await writeFile(manifestPath, manifestBytes);
  return { root, artifactPath, artifactBytes, manifestPath, manifestBytes };
}

async function createNativeSelectionFixture({
  cleanupVerified = true,
  dirty = false,
} = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "dure-native-source-selection-"));
  const scenario = "hmux-multiple-views";
  const runId = "2026-09-01T00-00-00.000Z-0123456789ab";
  const scenarioDirectory = resolve(root, "native-multi-window", scenario);
  const runDirectory = resolve(scenarioDirectory, runId);
  await mkdir(runDirectory, { recursive: true });
  const artifact = `${scenario}.webm`;
  const artifactPath = resolve(runDirectory, artifact);
  const artifactBytes = Buffer.from("verified-native-source-bytes");
  await writeFile(artifactPath, artifactBytes);
  const manifest = {
    schemaVersion: 3,
    scenarioId: scenario,
    descriptor: {
      buildId: "0.1.4+0123456789ab",
      packageVersion: "0.1.4",
    },
    applicationSource: {
      sourceRevision: "0123456789abcdef",
      workingTreeFingerprint: `git-working-tree-v1:${"a".repeat(64)}`,
      dirty,
    },
    recording: {
      requestedDurationMs: 15_000,
      video: {
        relativePath: artifact,
        bytes: artifactBytes.length,
        sha256: sha256(artifactBytes),
      },
    },
    captureProof: {
      profile: "hmux-native-view-handoff-v1",
      claim: { boundary: "view-handoff", status: "survived" },
      limitations: ["does-not-observe-native-app-restart"],
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(resolve(runDirectory, "manifest.json"), manifestBytes);
  const cleanupReceipt = {
    schemaVersion: 1,
    runId,
    scenarioId: scenario,
    runnerExitCode: 0,
    appProcessFinalStatus: "absent",
    cleanupVerified,
    manifest: {
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
    },
  };
  const cleanupBytes = Buffer.from(
    `${JSON.stringify(cleanupReceipt, null, 2)}\n`,
  );
  await writeFile(resolve(runDirectory, "cleanup-receipt.json"), cleanupBytes);
  const selection = verifiedNativeSourceSelection({
    scenarioId: scenario,
    runId,
    artifact: {
      name: artifact,
      bytes: artifactBytes.length,
      sha256: sha256(artifactBytes),
    },
    cleanupReceipt: {
      bytes: cleanupBytes.length,
      sha256: sha256(cleanupBytes),
    },
    manifest: {
      bytes: manifestBytes.length,
      sha256: sha256(manifestBytes),
    },
  });
  const selectionBytes = Buffer.from(`${JSON.stringify(selection, null, 2)}\n`);
  await writeFile(resolve(scenarioDirectory, "selected-source.json"), selectionBytes);
  return {
    artifactBytes,
    root,
    runId,
    scenario,
    selectionBytes,
  };
}

function nativeStoryboard(fixture) {
  const storyboard = structuredClone(ONBOARDING_LAUNCH_STORYBOARD);
  storyboard.sources = [
    {
      id: "native-handoff",
      kind: "native-selection",
      scenario: fixture.scenario,
      artifact: `${fixture.scenario}.webm`,
      proofProfile: "hmux-native-view-handoff-v1",
    },
  ];
  for (const shot of storyboard.shots) shot.sourceId = "native-handoff";
  return storyboard;
}

async function writeBrowserCapture({
  claim,
  profile,
  requestedDurationMs,
  root,
  scenario,
}) {
  const directory = resolve(root, "media", scenario);
  await mkdir(directory, { recursive: true });
  const artifact = `${scenario}.webm`;
  const artifactPath = resolve(directory, artifact);
  const artifactBytes = Buffer.from(`verified-browser-source:${scenario}`);
  await writeFile(artifactPath, artifactBytes);
  await writeFile(
    resolve(directory, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 4,
      scenario,
      applicationBuild: {
        buildId: "0.1.4+0123456789ab",
        packageVersion: "0.1.4",
        sourceRevision: "0123456789abcdef",
        dirty: false,
      },
      recording: { requestedDurationMs },
      artifacts: [
        {
          path: `output/playwright/media/${scenario}/${artifact}`,
          bytes: artifactBytes.length,
          sha256: sha256(artifactBytes),
        },
      ],
      captureProof: { profile, claim },
    }, null, 2)}\n`,
  );
}

async function createLifecycleProofFixture() {
  const fixture = await createNativeSelectionFixture();
  await Promise.all([
    writeBrowserCapture({
      claim: { boundary: "client-reconnect", status: "reattached" },
      profile: "hmux-client-reconnect-v1",
      requestedDurationMs: 10_800,
      root: fixture.root,
      scenario: "hmux-app-reconnect",
    }),
    writeBrowserCapture({
      claim: { boundary: "reboot-stale-session", status: "recovered" },
      profile: "hmux-reboot-stale-recovery-v1",
      requestedDurationMs: 12_000,
      root: fixture.root,
      scenario: "session-recovery",
    }),
  ]);
  return fixture;
}

async function compileFixture(fixture, overrides = {}) {
  return compileStoryboard({
    storyboard: ONBOARDING_LAUNCH_STORYBOARD,
    locale: "en",
    targetId: "mintlify",
    captureRoot: fixture.root,
    captureTrustRoot: fixture.root,
    captureBoundary: fixture.root,
    probeSourceMedia: async () => SOURCE_MEDIA,
    ...overrides,
  });
}

describe("storyboard source provenance", () => {
  it("binds the exact manifest and source bytes plus actual probed media facts", async () => {
    const fixture = await createFixture();
    try {
      const plan = await compileFixture(fixture);
      expect(plan.sources[0]).toMatchObject({
        capturePath: "media/onboarding-walkthrough/onboarding-walkthrough.webm",
        artifact: {
          bytes: fixture.artifactBytes.length,
          sha256: sha256(fixture.artifactBytes),
        },
        manifest: {
          capturePath: "media/onboarding-walkthrough/manifest.json",
          bytes: fixture.manifestBytes.length,
          sha256: sha256(fixture.manifestBytes),
        },
        requestedDurationMs: 17_000,
        durationMs: SOURCE_MEDIA.durationMs,
        media: SOURCE_MEDIA,
      });
      expect(plan.reviewRecipeSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(JSON.stringify(plan)).not.toContain(fixture.root);
      expect(await compileFixture(fixture)).toEqual(plan);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("compiles an atomically selected, clean native run through the same source contract", async () => {
    const fixture = await createNativeSelectionFixture();
    try {
      const plan = await compileFixture(fixture, {
        storyboard: nativeStoryboard(fixture),
        probeSourceMedia: async () => SOURCE_MEDIA,
      });
      expect(plan.sources[0]).toMatchObject({
        kind: "native-selection",
        capturePath: `native-multi-window/${fixture.scenario}/${fixture.runId}/${fixture.scenario}.webm`,
        artifact: {
          bytes: fixture.artifactBytes.length,
          sha256: sha256(fixture.artifactBytes),
        },
        selection: {
          capturePath: `native-multi-window/${fixture.scenario}/selected-source.json`,
          bytes: fixture.selectionBytes.length,
          sha256: sha256(fixture.selectionBytes),
        },
        captureProof: {
          claim: { boundary: "view-handoff", status: "survived" },
        },
      });
      expect(JSON.stringify(plan)).not.toContain(fixture.root);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects selected native runs with dirty source or incomplete cleanup", async () => {
    for (const [options, message] of [
      [{ dirty: true }, "clean build"],
      [{ cleanupVerified: false }, "cleanup was not verified"],
    ]) {
      const fixture = await createNativeSelectionFixture(options);
      try {
        await expect(
          compileFixture(fixture, {
            storyboard: nativeStoryboard(fixture),
            probeSourceMedia: async () => SOURCE_MEDIA,
          }),
        ).rejects.toThrow(message);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a source whose lifecycle proof profile does not match", async () => {
    const fixture = await createNativeSelectionFixture();
    const storyboard = nativeStoryboard(fixture);
    storyboard.sources[0].proofProfile = "hmux-client-reconnect-v1";
    try {
      await expect(
        compileFixture(fixture, {
          storyboard,
          probeSourceMedia: async () => SOURCE_MEDIA,
        }),
      ).rejects.toThrow("proof profile does not match");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("compiles short flagship and long lifecycle targets from the same bounded claims", async () => {
    const fixture = await createLifecycleProofFixture();
    const mediaBySource = {
      "view-handoff": {
        codec: "vp9",
        width: 1_920,
        height: 1_080,
        pixelFormat: "yuv420p",
        frameRate: "6/1",
        frameCount: 78,
        durationMs: 13_000,
      },
      "client-reconnect": {
        codec: "vp8",
        width: 1_920,
        height: 1_080,
        pixelFormat: "yuv420p",
        frameRate: "25/1",
        frameCount: 291,
        durationMs: 11_640,
      },
      "reboot-stale-recovery": {
        codec: "vp8",
        width: 1_920,
        height: 1_080,
        pixelFormat: "yuv420p",
        frameRate: "25/1",
        frameCount: 317,
        durationMs: 12_680,
      },
    };
    try {
      const launch = await compileStoryboard({
        storyboard: WORKSPACE_LIFECYCLE_PROOF_STORYBOARD,
        locale: "en",
        targetId: "launch",
        captureRoot: fixture.root,
        captureTrustRoot: fixture.root,
        captureBoundary: fixture.root,
        probeSourceMedia: async ({ sourceId }) => mediaBySource[sourceId],
      });
      const flagship = await compileStoryboard({
        storyboard: WORKSPACE_LIFECYCLE_PROOF_STORYBOARD,
        locale: "en",
        targetId: "flagship",
        captureRoot: fixture.root,
        captureTrustRoot: fixture.root,
        captureBoundary: fixture.root,
        probeSourceMedia: async ({ sourceId }) => mediaBySource[sourceId],
      });
      expect(launch.target.durationInFrames).toBe(1_520);
      expect(flagship.target.durationInFrames).toBe(575);
      expect(flagship.sources).toHaveLength(1);
      expect(launch.sources.map(({ captureProof }) => captureProof.claim.status)).toEqual([
        "survived",
        "reattached",
        "recovered",
      ]);
      for (const plan of [flagship, launch]) {
        const overlayText = plan.shots.flatMap((shot) => [
          shot.caption?.text,
          ...shot.callouts.map((callout) => callout.text),
        ]);
        expect(
          overlayText.filter((text) =>
            text?.includes("Run this workflow with two agents."),
          ),
        ).toHaveLength(1);
        expect(plan.shots.at(-1)?.caption?.text).toContain(
          "Run this workflow with two agents.",
        );
        expect(overlayText.some((text) => text?.startsWith("Current limit"))).toBe(
          true,
        );
      }
      expect(
        WORKSPACE_LIFECYCLE_PROOF_STORYBOARD.shots
          .filter(({ id }) => id.endsWith("-replay"))
          .every(({ caption }) =>
            WORKSPACE_LIFECYCLE_PROOF_STORYBOARD.copy.en[
              caption.key
            ].startsWith("Replay —"),
          ),
      ).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("derives validated canonical media facts from ffprobe output", () => {
    expect(
      canonicalSourceMediaFromProbe({
        streams: [
          {
            codec_name: "vp8",
            width: 1_920,
            height: 1_080,
            pix_fmt: "yuv420p",
            r_frame_rate: "25/1",
            nb_read_frames: "442",
          },
        ],
        format: { duration: "17.680000" },
      }),
    ).toEqual(SOURCE_MEDIA);
    expect(() =>
      canonicalSourceMediaFromProbe({
        streams: [
          {
            codec_name: "vp8",
            width: 1_920,
            height: 1_080,
            r_frame_rate: "25/1",
            nb_read_frames: "1",
          },
        ],
        format: { duration: "17.680000" },
      }),
    ).toThrow("same timeline");
  });

  it("uses actual source duration and detects source changes during probing", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        compileFixture(fixture, {
          probeSourceMedia: async () => ({
            ...SOURCE_MEDIA,
            frameCount: 425,
            durationMs: 16_999,
          }),
        }),
      ).rejects.toThrow("ends after source");

      await expect(
        compileFixture(fixture, {
          probeSourceMedia: async () => {
            await writeFile(fixture.artifactPath, "changed-during-probe");
            return SOURCE_MEDIA;
          },
        }),
      ).rejects.toThrow("changed while its media was probed");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("changes the review recipe for localized shots, policies, targets, canvas, and source identity", async () => {
    const fixture = await createFixture();
    try {
      const base = await compileFixture(fixture);
      const korean = await compileFixture(fixture, { locale: "ko" });
      const changedPolicy = structuredClone(ONBOARDING_LAUNCH_STORYBOARD);
      changedPolicy.review.perceptualDiff.maxDistance = 0.07;
      const policy = await compileFixture(fixture, {
        storyboard: changedPolicy,
      });
      const launch = await compileFixture(fixture, { targetId: "launch" });
      const changedCanvas = structuredClone(ONBOARDING_LAUNCH_STORYBOARD);
      changedCanvas.canvas.background = "#191919";
      const canvas = await compileFixture(fixture, {
        storyboard: changedCanvas,
      });
      const changedSource = await compileFixture(fixture, {
        probeSourceMedia: async () => ({ ...SOURCE_MEDIA, codec: "vp9" }),
      });
      expect(
        new Set([
          base.reviewRecipeSha256,
          korean.reviewRecipeSha256,
          policy.reviewRecipeSha256,
          launch.reviewRecipeSha256,
          canvas.reviewRecipeSha256,
          changedSource.reviewRecipeSha256,
        ]).size,
      ).toBe(6);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
