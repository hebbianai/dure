import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`canonical source probe has an invalid ${label}`);
  }
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`canonical source probe has an invalid ${label}`);
  }
  return parsed;
}

function normalizedFrameRate(value) {
  const match = /^(\d+)\/(\d+)$/u.exec(String(value));
  if (!match) {
    throw new Error("canonical source probe has an invalid frame rate");
  }
  const numerator = positiveInteger(match[1], "frame rate numerator");
  const denominator = positiveInteger(match[2], "frame rate denominator");
  return {
    frameRate: `${numerator}/${denominator}`,
    framesPerSecond: numerator / denominator,
  };
}

export function validateCanonicalSourceMedia(media) {
  if (typeof media?.codec !== "string" || media.codec.length === 0) {
    throw new Error("canonical source probe has no codec");
  }
  const { frameRate, framesPerSecond } = normalizedFrameRate(media.frameRate);
  const frameCount = positiveInteger(media.frameCount, "frame count");
  const durationMs = positiveInteger(media.durationMs, "duration");
  const frameDurationMs = (frameCount / framesPerSecond) * 1_000;
  if (
    Math.abs(frameDurationMs - durationMs) >
    Math.max(250, 2_000 / framesPerSecond)
  ) {
    throw new Error(
      "canonical source probe frame count and duration do not describe the same timeline",
    );
  }
  return {
    codec: media.codec,
    width: positiveInteger(media.width, "width"),
    height: positiveInteger(media.height, "height"),
    ...(typeof media.pixelFormat === "string" && media.pixelFormat.length > 0
      ? { pixelFormat: media.pixelFormat }
      : {}),
    frameRate,
    frameCount,
    durationMs,
  };
}

export function canonicalSourceMediaFromProbe(probe) {
  if (!Array.isArray(probe?.streams) || probe.streams.length !== 1) {
    throw new Error("canonical source probe must contain exactly one video stream");
  }
  const stream = probe.streams[0];
  const durationSeconds = positiveNumber(probe?.format?.duration, "duration");
  return validateCanonicalSourceMedia({
    codec: stream?.codec_name,
    width: stream?.width,
    height: stream?.height,
    pixelFormat: stream?.pix_fmt,
    frameRate: stream?.r_frame_rate,
    frameCount: stream?.nb_read_frames ?? stream?.nb_frames,
    durationMs: Math.round(durationSeconds * 1_000),
  });
}

export async function probeCanonicalSourceMedia({
  artifactPath,
  ffprobeBinary = process.env.DURE_MEDIA_FFPROBE_BIN || "ffprobe",
  signal,
}) {
  const { stdout } = await execFileAsync(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_frames,nb_read_frames:format=duration",
      "-of",
      "json",
      artifactPath,
    ],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      signal,
      timeout: 30_000,
    },
  );
  let probe;
  try {
    probe = JSON.parse(stdout);
  } catch (error) {
    throw new Error("ffprobe returned invalid canonical source metadata", {
      cause: error,
    });
  }
  return canonicalSourceMediaFromProbe(probe);
}
