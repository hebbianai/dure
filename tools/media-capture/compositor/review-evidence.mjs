import { createHash } from "node:crypto";

const PUBLIC_TEXT_PATTERNS = [
  /\/(?:Users|home)\//u,
  /(?:^|[^a-z])(?:localhost|127\.0\.0\.1)(?:[^a-z]|$)/iu,
  /@[a-z0-9.-]+\.[a-z]{2,}/iu,
  /(?:token|password|secret|credential)[=:]\S+/iu,
  /bypass permissions on/iu,
];

export function reviewFrameEvidence(frame) {
  const { detectedText = "", ...evidence } = frame;
  return {
    ...evidence,
    ocr: {
      characters: detectedText.length,
      sha256: createHash("sha256").update(detectedText).digest("hex"),
    },
  };
}

export function validateRenderProbe(probe, plan) {
  const stream = probe?.streams?.[0];
  const errors = [];
  if (stream?.width !== plan.target.width || stream?.height !== plan.target.height) {
    errors.push("render dimensions do not match the plan");
  }
  if (stream?.codec_name !== plan.target.codec) {
    errors.push("render codec does not match the plan");
  }
  const [numerator, denominator] = String(stream?.r_frame_rate)
    .split("/")
    .map(Number);
  const fps = denominator > 0 ? numerator / denominator : Number.NaN;
  if (!Number.isFinite(fps) || Math.abs(fps - plan.target.fps) > 0.01) {
    errors.push("render frame rate does not match the plan");
  }
  const frameCount = Number(stream?.nb_read_frames ?? stream?.nb_frames);
  if (frameCount !== plan.target.durationInFrames) {
    errors.push("render frame count does not match the plan");
  }
  if (errors.length > 0) {
    throw new Error(`storyboard render probe failed: ${errors.join(", ")}`);
  }
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    frameRate: stream.r_frame_rate,
    frameCount,
  };
}

function longestConsecutiveRun(frameNumbers) {
  let longest = 0;
  let current = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const frame of [...frameNumbers].sort((left, right) => left - right)) {
    current = frame === previous + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = frame;
  }
  return longest;
}

export function buildReviewEvidence({
  plan,
  probe,
  blankFrameScan,
  privacyScan,
  frames,
  artifactEvidence,
  renderEvidenceDigest,
}) {
  const media = validateRenderProbe(probe, plan);
  const byFrame = new Map(frames.map((frame) => [frame.frame, frame]));
  const errors = [];
  if (blankFrameScan?.totalFrames !== media.frameCount) {
    errors.push("blank-frame scan did not inspect every rendered frame");
  }
  if (
    privacyScan?.method !== "tesseract-keyframes" ||
    privacyScan?.scope !== "declared-review-keyframes" ||
    privacyScan?.inspectedFrames !== plan.review.keyframes.length ||
    !/^tesseract\s+\d+(?:\.\d+)+/iu.test(
      privacyScan?.engine?.version ?? "",
    ) ||
    !/^[0-9a-f]{64}$/u.test(
      privacyScan?.engine?.fingerprintSha256 ?? "",
    )
  ) {
    errors.push("privacy OCR did not inspect every review keyframe");
  }
  if (
    !Number.isInteger(artifactEvidence?.bytes) ||
    artifactEvidence.bytes <= 0 ||
    !/^[0-9a-f]{64}$/u.test(artifactEvidence?.sha256 ?? "")
  ) {
    errors.push("render artifact identity is missing");
  }
  if (
    !Number.isInteger(renderEvidenceDigest?.bytes) ||
    renderEvidenceDigest.bytes <= 0 ||
    !/^[0-9a-f]{64}$/u.test(renderEvidenceDigest?.sha256 ?? "")
  ) {
    errors.push("render evidence identity is missing");
  }
  const longestBlankRun = longestConsecutiveRun(blankFrameScan?.frames ?? []);
  if (longestBlankRun > plan.review.blankFrame.maxConsecutiveFrames) {
    errors.push(`render contains ${longestBlankRun} consecutive blank frames`);
  }
  const keyframes = plan.review.keyframes.map((frameNumber) => {
    const frame = byFrame.get(frameNumber);
    if (!frame) {
      errors.push(`missing review frame ${frameNumber}`);
      return null;
    }
    if (frame.blackRatio >= plan.review.blankFrame.blackRatio) {
      errors.push(`review frame ${frameNumber} is blank`);
    }
    if (!/^[0-9a-f]{16}$/u.test(frame.perceptualHash ?? "")) {
      errors.push(`review frame ${frameNumber} has no perceptual hash`);
    }
    if (!/^[0-9a-f]{16}$/u.test(frame.baselineHash ?? "")) {
      errors.push(`review frame ${frameNumber} has no approved baseline`);
    }
    if (!Number.isFinite(frame.perceptualDistance)) {
      errors.push(`review frame ${frameNumber} has no perceptual comparison`);
    } else if (frame.perceptualDistance > plan.review.perceptualDiff.maxDistance) {
      errors.push(`review frame ${frameNumber} exceeds perceptual diff budget`);
    }
    if ((frame.detectedText ?? "").trim().length === 0) {
      errors.push(`review frame ${frameNumber} has empty OCR text`);
    }
    for (const pattern of PUBLIC_TEXT_PATTERNS) {
      if (pattern.test(frame.detectedText ?? "")) {
        errors.push(`review frame ${frameNumber} contains forbidden public text`);
      }
    }
    return reviewFrameEvidence(frame);
  });
  if (errors.length > 0) {
    throw new Error(`storyboard review failed: ${errors.join("; ")}`);
  }
  return {
    schema: "dure-storyboard-review-evidence/v1",
    renderPlanSha256: plan.renderPlanSha256,
    reviewRecipeSha256: plan.reviewRecipeSha256,
    artifact: artifactEvidence,
    renderEvidence: renderEvidenceDigest,
    media,
    blankFrameScan: {
      totalFrames: blankFrameScan.totalFrames,
      blankFrames: blankFrameScan.frames,
      longestConsecutiveRun: longestBlankRun,
    },
    safeArea: plan.canvas.safeArea,
    privacyPolicy: plan.review.privacyPolicy,
    privacyScan,
    keyframes,
  };
}
