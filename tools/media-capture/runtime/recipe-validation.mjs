export function validateReadmeGifRecipe(recipe, scenarioDurationMs) {
  const errors = [];
  if (recipe?.schemaVersion !== 1) {
    errors.push("readmeGif.schemaVersion must be 1");
  }
  if (!Array.isArray(recipe?.segments) || recipe.segments.length === 0) {
    errors.push("readmeGif.segments must be a non-empty array");
  } else {
    let previousEndMs = -1;
    for (const [index, segment] of recipe.segments.entries()) {
      if (
        !Number.isInteger(segment?.startMs) ||
        !Number.isInteger(segment?.endMs) ||
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs
      ) {
        errors.push(`readmeGif.segments[${index}] is invalid`);
        continue;
      }
      if (segment.startMs < previousEndMs) {
        errors.push("readmeGif.segments must be sorted and non-overlapping");
      }
      if (segment.endMs > scenarioDurationMs) {
        errors.push("readmeGif.segments must stay within the scenario duration");
      }
      previousEndMs = segment.endMs;
    }
  }
  for (const [label, minimum, maximum] of [
    ["fps", 1, 24],
    ["width", 320, 1_600],
    ["maxColors", 2, 256],
  ]) {
    const value = recipe?.[label];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(
        `readmeGif.${label} must be an integer from ${minimum} to ${maximum}`,
      );
    }
  }
  if (recipe?.loop !== 0) {
    errors.push("readmeGif.loop must be 0");
  }
  return errors;
}

export function validatePublicWebmRecipe(recipe, scenarioDurationMs) {
  const errors = [];
  if (recipe?.schemaVersion !== 1) {
    errors.push("publicWebm.schemaVersion must be 1");
  }
  if (!Array.isArray(recipe?.segments) || recipe.segments.length === 0) {
    errors.push("publicWebm.segments must be a non-empty array");
  } else {
    let previousEndMs = -1;
    for (const [index, segment] of recipe.segments.entries()) {
      if (
        !Number.isInteger(segment?.startMs) ||
        !Number.isInteger(segment?.endMs) ||
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs
      ) {
        errors.push(`publicWebm.segments[${index}] is invalid`);
        continue;
      }
      if (segment.startMs < previousEndMs) {
        errors.push("publicWebm.segments must be sorted and non-overlapping");
      }
      if (segment.endMs > scenarioDurationMs) {
        errors.push("publicWebm.segments must stay within the scenario duration");
      }
      previousEndMs = segment.endMs;
    }
  }
  for (const [label, minimum, maximum] of [
    ["fps", 1, 60],
    ["width", 320, 3_840],
    ["crf", 0, 63],
  ]) {
    const value = recipe?.[label];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(
        `publicWebm.${label} must be an integer from ${minimum} to ${maximum}`,
      );
    }
  }
  if (Number.isInteger(recipe?.fps) && Array.isArray(recipe?.segments)) {
    let totalFrameCount = 0;
    for (const [index, segment] of recipe.segments.entries()) {
      if (
        Number.isInteger(segment?.startMs) &&
        Number.isInteger(segment?.endMs)
      ) {
        if (
          (segment.startMs * recipe.fps) % 1_000 !== 0 ||
          (segment.endMs * recipe.fps) % 1_000 !== 0
        ) {
          errors.push(
            `publicWebm.segments[${index}] must align to the fps frame grid`,
          );
        }
        totalFrameCount +=
          ((segment.endMs - segment.startMs) * recipe.fps) / 1_000;
      }
    }
    if (totalFrameCount < 2) {
      errors.push("publicWebm.segments must produce at least 2 frames");
    }
  }
  if (Number.isInteger(recipe?.width) && recipe.width % 2 !== 0) {
    errors.push("publicWebm.width must be even");
  }
  if (recipe?.codec !== "vp9") {
    errors.push("publicWebm.codec must be vp9");
  }
  if (recipe?.pixelFormat !== "yuv420p") {
    errors.push("publicWebm.pixelFormat must be yuv420p");
  }
  if (recipe?.threads !== 1) {
    errors.push("publicWebm.threads must be 1");
  }
  if (recipe?.deadline !== "good") {
    errors.push("publicWebm.deadline must be good");
  }
  if (
    !Number.isInteger(recipe?.cpuUsed) ||
    recipe.cpuUsed < 0 ||
    recipe.cpuUsed > 8
  ) {
    errors.push("publicWebm.cpuUsed must be an integer from 0 to 8");
  }
  if (recipe?.rowMt !== 0) {
    errors.push("publicWebm.rowMt must be 0");
  }
  if (recipe?.bitrateKbps !== 0) {
    errors.push("publicWebm.bitrateKbps must be 0 for constant-quality encoding");
  }
  if (recipe?.timeBase !== "1/1000") {
    errors.push("publicWebm.timeBase must be 1/1000");
  }
  return errors;
}
