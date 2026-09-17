import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { assertValidStoryboard } from "./schema.mjs";
import { repoRoot, transientOutputRoot } from "../paths.mjs";
import { resolveSafeExistingDirectory } from "./secure-output.mjs";
import { probeCanonicalSourceMedia } from "./source-media.mjs";
import { loadVerifiedStoryboardSource } from "./source-selection.mjs";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertContained(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, pathFromRoot) !== candidate
  ) {
    throw new Error(`${label} escapes the capture root`);
  }
}

function assertContainedOrEqual(root, candidate, label) {
  if (resolve(root) === resolve(candidate)) return;
  assertContained(root, candidate, label);
}

function frameAt(milliseconds, fps) {
  return Math.round((milliseconds * fps) / 1_000);
}

function compileOverlay(overlay, shotStartFrame, shotDurationInFrames, fps, text) {
  const startOffset = Math.min(
    shotDurationInFrames - 1,
    frameAt(overlay.startMs, fps),
  );
  const endOffset = Math.min(
    shotDurationInFrames,
    Math.max(startOffset + 1, frameAt(overlay.endMs, fps)),
  );
  return {
    text,
    startFrame: shotStartFrame + startOffset,
    endFrame: shotStartFrame + endOffset,
    ...(overlay.tone ? { tone: overlay.tone } : {}),
    ...(overlay.rect ? { rect: overlay.rect } : {}),
    ...(overlay.target ? { target: overlay.target } : {}),
    ...(overlay.labelRect ? { labelRect: overlay.labelRect } : {}),
  };
}

export async function compileStoryboard({
  storyboard,
  locale,
  targetId,
  captureRoot,
  captureTrustRoot = repoRoot,
  captureBoundary = transientOutputRoot,
  probeSourceMedia = probeCanonicalSourceMedia,
}) {
  assertValidStoryboard(storyboard);
  const target = storyboard.targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`unknown target ${targetId} for ${storyboard.id}`);
  const copy = storyboard.copy[locale];
  if (!copy) throw new Error(`unknown locale ${locale} for ${storyboard.id}`);
  const shotsById = new Map(storyboard.shots.map((shot) => [shot.id, shot]));
  const selectedShots = target.shotIds.map((shotId) => shotsById.get(shotId));
  const selectedSourceIds = new Set(selectedShots.map((shot) => shot.sourceId));
  assertContainedOrEqual(
    captureBoundary,
    resolve(captureRoot),
    "storyboard capture root",
  );
  const resolvedCaptureRoot = await resolveSafeExistingDirectory({
    allowedRoot: captureTrustRoot,
    directory: captureRoot,
    label: "storyboard capture root",
  });
  const sources = await Promise.all(
    storyboard.sources
      .filter((source) => selectedSourceIds.has(source.id))
      .map((source) =>
        loadVerifiedStoryboardSource({
          source,
          captureRoot: resolvedCaptureRoot,
          probeSourceMedia,
        }),
      ),
  );
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  let timelineFrame = 0;
  const shots = selectedShots.map((shot) => {
    const source = sourcesById.get(shot.sourceId);
    if (shot.sourceEndMs > source.durationMs) {
      throw new Error(
        `shot ${shot.id} ends after source ${source.id} at ${source.durationMs}ms`,
      );
    }
    const sourceStartFrame = frameAt(shot.sourceStartMs, target.fps);
    const sourceEndFrame = Math.max(
      sourceStartFrame + 1,
      frameAt(shot.sourceEndMs, target.fps),
    );
    const durationInFrames = sourceEndFrame - sourceStartFrame;
    const compiled = {
      id: shot.id,
      sourceId: shot.sourceId,
      sourceStartMs: shot.sourceStartMs,
      sourceEndMs: shot.sourceEndMs,
      sourceStartFrame,
      sourceEndFrame,
      startFrame: timelineFrame,
      durationInFrames,
      crop: shot.crop,
      zoom: shot.zoom,
      caption: shot.caption
        ? compileOverlay(
            shot.caption,
            timelineFrame,
            durationInFrames,
            target.fps,
            copy[shot.caption.key],
          )
        : null,
      callouts: (shot.callouts ?? []).map((callout) =>
        compileOverlay(
          callout,
          timelineFrame,
          durationInFrames,
          target.fps,
          copy[callout.key],
        ),
      ),
    };
    timelineFrame += durationInFrames;
    return compiled;
  });
  const plan = {
    schema: "dure-storyboard-render-plan/v1",
    storyboard: {
      id: storyboard.id,
      schemaVersion: storyboard.schemaVersion,
      sha256: sha256Json(storyboard),
    },
    locale,
    target: {
      id: target.id,
      format: target.format,
      codec: target.codec,
      width: target.width,
      height: target.height,
      fps: target.fps,
      durationInFrames: timelineFrame,
    },
    canvas: storyboard.canvas,
    sources,
    shots,
    review: {
      ...storyboard.review,
      keyframes: storyboard.review.perceptualDiff.keyframeProgress.map(
        (progress) =>
          Math.min(
            timelineFrame - 1,
            Math.round(progress * (timelineFrame - 1)),
          ),
      ),
    },
    timing: { rounding: "nearest-frame" },
  };
  const reviewRecipeSha256 = sha256Json({
    schema: "dure-storyboard-review-recipe/v1",
    storyboardSha256: plan.storyboard.sha256,
    locale: plan.locale,
    target: plan.target,
    canvas: plan.canvas,
    sources: plan.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      scenario: source.scenario,
      capturePath: source.capturePath,
      artifact: source.artifact,
      manifest: source.manifest,
      selection: source.selection ?? null,
      cleanupReceipt: source.cleanupReceipt ?? null,
      captureProof: source.captureProof,
      media: source.media,
    })),
    shots: plan.shots,
    review: plan.review,
  });
  const planWithReviewRecipe = {
    ...plan,
    reviewRecipeSha256,
  };
  return {
    ...planWithReviewRecipe,
    renderPlanSha256: sha256Json(planWithReviewRecipe),
  };
}
