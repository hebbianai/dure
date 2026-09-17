export function captureArtifactPlan(format, scenario) {
  const gif = format === "gif" || (format === "all" && scenario.readmeGif);
  if (format === "gif" && !scenario.readmeGif) {
    throw new Error(`${scenario.id} does not declare a readmeGif recipe`);
  }
  return {
    png: format === "all" || format === "png",
    webm: format === "all" || format === "gif" || format === "webm",
    gif: Boolean(gif),
    publicWebm: format === "all" && Boolean(scenario.publicWebm),
  };
}
