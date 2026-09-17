export function blackPixelRatio(grayFrame, threshold) {
  if (!(grayFrame instanceof Uint8Array) || grayFrame.length === 0) {
    throw new Error("gray frame must contain pixels");
  }
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new Error("luma threshold must be an integer between 0 and 255");
  }
  let blackPixels = 0;
  for (const luma of grayFrame) {
    if (luma <= threshold) blackPixels += 1;
  }
  return blackPixels / grayFrame.length;
}

export function differenceHashFromGrayFrame(grayFrame, width, height) {
  if (
    !(grayFrame instanceof Uint8Array) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 9 ||
    height < 8 ||
    grayFrame.length !== width * height
  ) {
    throw new Error("dHash input must be a complete grayscale frame of at least 9x8");
  }
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) * height) / 8));
    for (let column = 0; column < 8; column += 1) {
      const leftX = Math.min(
        width - 1,
        Math.floor(((column + 0.5) * width) / 9),
      );
      const rightX = Math.min(
        width - 1,
        Math.floor(((column + 1.5) * width) / 9),
      );
      hash =
        (hash << 1n) |
        (grayFrame[y * width + leftX] > grayFrame[y * width + rightX]
          ? 1n
          : 0n);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function normalizedHashDistance(left, right) {
  if (!/^[0-9a-f]{16}$/u.test(left) || !/^[0-9a-f]{16}$/u.test(right)) {
    throw new Error("perceptual hashes must be 64-bit lowercase hex strings");
  }
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits > 0n) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance / 64;
}

export function reviewFrameRecord({
  frame,
  grayFrame,
  width,
  height,
  lumaThreshold,
  baselineHash,
  detectedText = "",
}) {
  const perceptualHash = differenceHashFromGrayFrame(grayFrame, width, height);
  return {
    frame,
    blackRatio: blackPixelRatio(grayFrame, lumaThreshold),
    perceptualHash,
    baselineHash: baselineHash ?? null,
    perceptualDistance: baselineHash
      ? normalizedHashDistance(perceptualHash, baselineHash)
      : null,
    detectedText,
  };
}
