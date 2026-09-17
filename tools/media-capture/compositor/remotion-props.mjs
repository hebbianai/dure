export const REMOTION_ADAPTER_SCHEMA = "dure-remotion-props/v1";

export function remotionPropsFromRenderPlan(plan) {
  if (plan?.schema !== "dure-storyboard-render-plan/v1") {
    throw new Error("unsupported storyboard render plan");
  }
  return {
    schema: REMOTION_ADAPTER_SCHEMA,
    compositionId: "DureStoryboard",
    width: plan.target.width,
    height: plan.target.height,
    fps: plan.target.fps,
    durationInFrames: plan.target.durationInFrames,
    inputProps: {
      canvas: plan.canvas,
      locale: plan.locale,
      target: plan.target,
      sources: plan.sources.map((source) => ({
        id: source.id,
        ...(source.input ? { input: source.input } : {}),
        capturePath: source.capturePath,
        bytes: source.artifact.bytes,
        sha256: source.artifact.sha256,
      })),
      shots: plan.shots,
      reviewKeyframes: plan.review.keyframes,
      renderPlanSha256: plan.renderPlanSha256,
    },
  };
}
