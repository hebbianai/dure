export const REVIEW_BASELINE_SCHEMA = "dure-storyboard-perceptual-baseline/v2";

function sourceIdentity(source) {
  return {
    sourceId: source.id,
    bytes: source.artifact.bytes,
    sha256: source.artifact.sha256,
  };
}

export function validateReviewBaseline(baseline, plan) {
  const errors = [];
  if (baseline?.schema !== REVIEW_BASELINE_SCHEMA) {
    errors.push("unsupported review baseline schema");
  }
  if (baseline?.storyboardId !== plan.storyboard.id) {
    errors.push("review baseline storyboard does not match");
  }
  if (baseline?.targetId !== plan.target.id) {
    errors.push("review baseline target does not match");
  }
  if (baseline?.locale !== plan.locale) {
    errors.push("review baseline locale does not match");
  }
  if (baseline?.storyboardSha256 !== plan.storyboard.sha256) {
    errors.push("review baseline storyboard bytes do not match");
  }
  if (baseline?.reviewRecipeSha256 !== plan.reviewRecipeSha256) {
    errors.push("review baseline recipe does not match");
  }
  if (
    JSON.stringify(baseline?.sourceArtifacts) !==
    JSON.stringify(plan.sources.map(sourceIdentity))
  ) {
    errors.push("review baseline source artifacts do not match");
  }
  if (!Array.isArray(baseline?.frames)) {
    errors.push("review baseline frames must be an array");
  } else {
    if (baseline.frames.length !== plan.review.keyframes.length) {
      errors.push("review baseline must cover every review keyframe");
    }
    for (let index = 0; index < baseline.frames.length; index += 1) {
      const frame = baseline.frames[index];
      if (frame?.frame !== plan.review.keyframes[index]) {
        errors.push(`review baseline frame ${index} does not match the plan`);
      }
      if (!/^[0-9a-f]{16}$/u.test(frame?.perceptualHash ?? "")) {
        errors.push(`review baseline frame ${index} has an invalid perceptual hash`);
      }
    }
  }
  return errors;
}

export function assertReviewBaseline(baseline, plan) {
  const errors = validateReviewBaseline(baseline, plan);
  if (errors.length > 0) {
    throw new Error(`invalid storyboard review baseline: ${errors.join("; ")}`);
  }
  return baseline;
}

export function reviewBaselineCandidate(plan, frames) {
  return {
    schema: REVIEW_BASELINE_SCHEMA,
    storyboardId: plan.storyboard.id,
    targetId: plan.target.id,
    locale: plan.locale,
    storyboardSha256: plan.storyboard.sha256,
    reviewRecipeSha256: plan.reviewRecipeSha256,
    sourceArtifacts: plan.sources.map(sourceIdentity),
    sourceBuilds: plan.sources.map((source) => ({
      sourceId: source.id,
      buildId: source.applicationBuild.buildId,
      sourceRevision: source.applicationBuild.sourceRevision,
    })),
    frames: frames.map(({ frame, perceptualHash }) => ({
      frame,
      perceptualHash,
    })),
  };
}
