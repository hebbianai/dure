const PRIVATE_TEXT_PATTERNS = [
  /\/(?:Users|home)\//u,
  /(?:^|[^a-z])(?:localhost|127\.0\.0\.1)(?:[^a-z]|$)/iu,
  /@[a-z0-9.-]+\.[a-z]{2,}/iu,
  /(?:token|password|secret|credential)[=:]\S+/iu,
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizedRectErrors(rect, label) {
  if (!isRecord(rect)) return [`${label} must be an object`];
  const errors = [];
  for (const key of ["x", "y", "width", "height"]) {
    const value = rect[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      errors.push(`${label}.${key} must be between 0 and 1`);
    }
  }
  if (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.width) &&
    rect.x + rect.width > 1
  ) {
    errors.push(`${label} must fit horizontally`);
  }
  if (
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.height) &&
    rect.y + rect.height > 1
  ) {
    errors.push(`${label} must fit vertically`);
  }
  return errors;
}

function overlayRectErrors(rect, safeArea, canvas, label) {
  if (!isRecord(rect)) return [`${label} must be an object`];
  const errors = [];
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isFinite(rect[key]) || rect[key] < 0) {
      errors.push(`${label}.${key} must be non-negative`);
    }
  }
  if (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.width) &&
    rect.x < safeArea.left
  ) {
    errors.push(`${label} crosses the left safe area`);
  }
  if (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.width) &&
    rect.x + rect.width > canvas.width - safeArea.right
  ) {
    errors.push(`${label} crosses the right safe area`);
  }
  if (
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.height) &&
    rect.y < safeArea.top
  ) {
    errors.push(`${label} crosses the top safe area`);
  }
  if (
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.height) &&
    rect.y + rect.height > canvas.height - safeArea.bottom
  ) {
    errors.push(`${label} crosses the bottom safe area`);
  }
  return errors;
}

export function validateStoryboard(storyboard) {
  const errors = [];
  if (storyboard?.schemaVersion !== 1) {
    errors.push("storyboard.schemaVersion must be 1");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(storyboard?.id ?? "")) {
    errors.push("storyboard.id must be kebab-case");
  }
  const canvas = storyboard?.canvas;
  if (!isPositiveInteger(canvas?.width) || !isPositiveInteger(canvas?.height)) {
    errors.push("storyboard.canvas must have positive integer dimensions");
  }
  const safeArea = canvas?.safeArea;
  if (!isRecord(safeArea)) {
    errors.push("storyboard.canvas.safeArea must be an object");
  } else {
    for (const edge of ["top", "right", "bottom", "left"]) {
      if (!Number.isInteger(safeArea[edge]) || safeArea[edge] < 0) {
        errors.push(`storyboard.canvas.safeArea.${edge} must be non-negative`);
      }
    }
    if (
      isPositiveInteger(canvas?.width) &&
      safeArea.left + safeArea.right >= canvas.width
    ) {
      errors.push("storyboard.canvas.safeArea must leave horizontal content space");
    }
    if (
      isPositiveInteger(canvas?.height) &&
      safeArea.top + safeArea.bottom >= canvas.height
    ) {
      errors.push("storyboard.canvas.safeArea must leave vertical content space");
    }
  }

  const sourceIds = new Set();
  if (!Array.isArray(storyboard?.sources) || storyboard.sources.length === 0) {
    errors.push("storyboard.sources must be non-empty");
  } else {
    for (const source of storyboard.sources) {
      if (!source?.id || sourceIds.has(source.id)) {
        errors.push("storyboard source ids must be present and unique");
      }
      sourceIds.add(source?.id);
      if (!["browser-capture", "native-selection"].includes(source?.kind)) {
        errors.push(`source ${source?.id ?? "unknown"} has an invalid kind`);
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source?.scenario ?? "")) {
        errors.push(`source ${source?.id ?? "unknown"} has an invalid scenario`);
      }
      if (
        source?.proofProfile !== undefined &&
        !/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/u.test(
          source.proofProfile,
        )
      ) {
        errors.push(`source ${source?.id ?? "unknown"} has an invalid proof profile`);
      }
      if (
        !/^[a-z0-9][a-z0-9.-]*\.(?:webm|mp4)$/u.test(source?.artifact ?? "") ||
        source.artifact.includes("..")
      ) {
        errors.push(`source ${source?.id ?? "unknown"} has an unsafe artifact`);
      }
    }
  }

  const shotIds = new Set();
  const captionKeys = new Set();
  if (!Array.isArray(storyboard?.shots) || storyboard.shots.length === 0) {
    errors.push("storyboard.shots must be non-empty");
  } else {
    for (const shot of storyboard.shots) {
      const label = `shot ${shot?.id ?? "unknown"}`;
      if (!shot?.id || shotIds.has(shot.id)) {
        errors.push("storyboard shot ids must be present and unique");
      }
      shotIds.add(shot?.id);
      if (!sourceIds.has(shot?.sourceId)) {
        errors.push(`${label} references an unknown source`);
      }
      if (
        !Number.isInteger(shot?.sourceStartMs) ||
        !Number.isInteger(shot?.sourceEndMs) ||
        shot.sourceStartMs < 0 ||
        shot.sourceEndMs <= shot.sourceStartMs
      ) {
        errors.push(`${label} has an invalid source interval`);
      }
      errors.push(...normalizedRectErrors(shot?.crop, `${label}.crop`));
      for (const endpoint of ["from", "to"]) {
        const zoom = shot?.zoom?.[endpoint];
        if (!Number.isFinite(zoom) || zoom < 1 || zoom > 2) {
          errors.push(`${label}.zoom.${endpoint} must be between 1 and 2`);
        }
      }
      errors.push(
        ...normalizedRectErrors(
          {
            x: shot?.zoom?.anchor?.x,
            y: shot?.zoom?.anchor?.y,
            width: 0,
            height: 0,
          },
          `${label}.zoom.anchor`,
        ),
      );
      if (shot?.caption) {
        captionKeys.add(shot.caption.key);
        if (
          shot.caption.tone !== undefined &&
          !["neutral", "observed", "replay"].includes(shot.caption.tone)
        ) {
          errors.push(`${label}.caption has an invalid tone`);
        }
        if (
          !Number.isInteger(shot.caption.startMs) ||
          !Number.isInteger(shot.caption.endMs) ||
          shot.caption.startMs < 0 ||
          shot.caption.endMs <= shot.caption.startMs ||
          shot.caption.endMs > shot.sourceEndMs - shot.sourceStartMs
        ) {
          errors.push(`${label}.caption has an invalid interval`);
        }
        if (isRecord(safeArea) && isRecord(canvas)) {
          errors.push(
            ...overlayRectErrors(
              shot.caption.rect,
              safeArea,
              canvas,
              `${label}.caption.rect`,
            ),
          );
        }
      }
      for (const [index, callout] of (shot?.callouts ?? []).entries()) {
        captionKeys.add(callout.key);
        if (
          !Number.isInteger(callout.startMs) ||
          !Number.isInteger(callout.endMs) ||
          callout.startMs < 0 ||
          callout.endMs <= callout.startMs ||
          callout.endMs > shot.sourceEndMs - shot.sourceStartMs
        ) {
          errors.push(`${label}.callouts[${index}] has an invalid interval`);
        }
        errors.push(
          ...normalizedRectErrors(
            callout.target,
            `${label}.callouts[${index}].target`,
          ),
        );
        if (isRecord(safeArea) && isRecord(canvas)) {
          errors.push(
            ...overlayRectErrors(
              callout.labelRect,
              safeArea,
              canvas,
              `${label}.callouts[${index}].labelRect`,
            ),
          );
        }
      }
    }
  }

  const locales = Object.keys(storyboard?.copy ?? {});
  if (locales.length === 0) errors.push("storyboard.copy must be non-empty");
  for (const locale of locales) {
    const copy = storyboard.copy[locale];
    for (const key of captionKeys) {
      if (typeof copy?.[key] !== "string" || copy[key].trim().length === 0) {
        errors.push(`storyboard.copy.${locale}.${key} must be non-empty`);
      }
    }
  }

  const targetIds = new Set();
  if (!Array.isArray(storyboard?.targets) || storyboard.targets.length === 0) {
    errors.push("storyboard.targets must be non-empty");
  } else {
    for (const target of storyboard.targets) {
      if (!target?.id || targetIds.has(target.id)) {
        errors.push("storyboard target ids must be present and unique");
      }
      targetIds.add(target?.id);
      if (!isPositiveInteger(target?.fps) || target.fps > 60) {
        errors.push(`target ${target?.id ?? "unknown"} has an invalid fps`);
      }
      if (!isPositiveInteger(target?.width) || !isPositiveInteger(target?.height)) {
        errors.push(`target ${target?.id ?? "unknown"} has invalid dimensions`);
      } else if (
        isPositiveInteger(canvas?.width) &&
        isPositiveInteger(canvas?.height) &&
        target.width * canvas.height !== target.height * canvas.width
      ) {
        errors.push(`target ${target?.id ?? "unknown"} must match the canvas aspect ratio`);
      }
      if (!["gif", "mp4", "webm"].includes(target?.format)) {
        errors.push(`target ${target?.id ?? "unknown"} has an invalid format`);
      }
      const validCodec =
        (target?.format === "gif" && target?.codec === "gif") ||
        (target?.format === "mp4" && target?.codec === "h264") ||
        (target?.format === "webm" && ["vp8", "vp9"].includes(target?.codec));
      if (!validCodec) {
        errors.push(`target ${target?.id ?? "unknown"} has an invalid codec`);
      }
      if (!Array.isArray(target?.shotIds) || target.shotIds.length === 0) {
        errors.push(`target ${target?.id ?? "unknown"} must select at least one shot`);
      }
      if (new Set(target?.shotIds ?? []).size !== (target?.shotIds ?? []).length) {
        errors.push(`target ${target?.id ?? "unknown"} must not repeat shots`);
      }
      for (const shotId of target?.shotIds ?? []) {
        if (!shotIds.has(shotId)) {
          errors.push(`target ${target?.id ?? "unknown"} references an unknown shot`);
        }
      }
    }
  }

  const keyframeProgress = storyboard?.review?.perceptualDiff?.keyframeProgress;
  if (
    storyboard?.review?.privacyPolicy !== "dure-public-media/v1" ||
    !Number.isFinite(storyboard?.review?.blankFrame?.blackRatio) ||
    storyboard.review.blankFrame.blackRatio <= 0 ||
    storyboard.review.blankFrame.blackRatio > 1 ||
    !Number.isInteger(storyboard?.review?.blankFrame?.lumaThreshold) ||
    storyboard.review.blankFrame.lumaThreshold < 0 ||
    storyboard.review.blankFrame.lumaThreshold > 255 ||
    !Number.isInteger(storyboard?.review?.blankFrame?.maxConsecutiveFrames) ||
    storyboard.review.blankFrame.maxConsecutiveFrames < 0 ||
    !Number.isFinite(storyboard?.review?.perceptualDiff?.maxDistance) ||
    storyboard.review.perceptualDiff.maxDistance < 0 ||
    storyboard.review.perceptualDiff.maxDistance > 1
  ) {
    errors.push("storyboard.review must declare the v1 review policy");
  }
  if (
    !Array.isArray(keyframeProgress) ||
    keyframeProgress.length === 0 ||
    keyframeProgress.some(
      (progress) => !Number.isFinite(progress) || progress < 0 || progress > 1,
    ) ||
    new Set(keyframeProgress).size !== keyframeProgress.length
  ) {
    errors.push(
      "storyboard.review.perceptualDiff.keyframeProgress must contain unique values between 0 and 1",
    );
  }

  const serialized = JSON.stringify(storyboard);
  for (const pattern of PRIVATE_TEXT_PATTERNS) {
    if (pattern.test(serialized)) {
      errors.push(`storyboard contains forbidden public text matching ${pattern}`);
    }
  }
  return errors;
}

export function assertValidStoryboard(storyboard) {
  const errors = validateStoryboard(storyboard);
  if (errors.length > 0) {
    throw new Error(`invalid storyboard ${storyboard?.id ?? "unknown"}: ${errors.join("; ")}`);
  }
  return storyboard;
}
