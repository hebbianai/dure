import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { nativeDesktopStageFilter } from "./desktop-stage.mjs";

const execFileAsync = promisify(execFile);

export function nativeWindowVideoEncoding(fps) {
  if (!Number.isInteger(fps) || fps < 1 || fps > 15) {
    throw new Error("native window video fps must be an integer from 1 to 15");
  }
  return {
    codec: "vp9",
    crf: 24,
    bitrate: 0,
    pixelFormat: "yuv420p",
    keyframeInterval: 1,
    automaticAlternateReferenceFrames: false,
    rowMultithreading: false,
    threads: 1,
  };
}

export function nativeWindowVideoEncodingOptions(fps) {
  const encoding = nativeWindowVideoEncoding(fps);
  return [
    "-an",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    String(encoding.crf),
    "-b:v",
    String(encoding.bitrate),
    "-pix_fmt",
    encoding.pixelFormat,
    "-g",
    String(encoding.keyframeInterval),
    "-auto-alt-ref",
    encoding.automaticAlternateReferenceFrames ? "1" : "0",
    "-row-mt",
    encoding.rowMultithreading ? "1" : "0",
    "-threads",
    String(encoding.threads),
  ];
}

export function nativeWindowFramePath(pattern, frame) {
  if (
    typeof pattern !== "string" ||
    pattern.includes("\0") ||
    pattern.split("%05d").length !== 2
  ) {
    throw new Error("native window frame pattern must contain one %05d token");
  }
  if (!Number.isSafeInteger(frame) || frame < 0 || frame > 99_999) {
    throw new Error("native window frame number is invalid");
  }
  return pattern.replace("%05d", String(frame).padStart(5, "0"));
}

function binary(environmentKey, fallback) {
  const value = process.env[environmentKey] ?? fallback;
  if (!value || value.includes("\0")) throw new Error(`${environmentKey} is invalid`);
  return value;
}

export function nativeWindowCompositionFilter({
  duration,
  fps,
  scenarioId,
}) {
  const canvas = nativeDesktopStageFilter({ duration, fps });
  if (scenarioId === "hmux-multiple-views") {
    return [
      "[0:v]scale=1120:-2:flags=lanczos[workspace]",
      "[1:v]scale=820:-2:flags=lanczos[session]",
      canvas,
      "[canvas][workspace]overlay=x=40:y=52:shortest=1[withworkspace]",
      "[withworkspace][session]overlay=x=W-w-40:y=H-h-52:shortest=1[out]",
    ].join(";");
  }
  return [
    "[0:v]scale=900:-2:flags=lanczos[left]",
    "[1:v]scale=900:-2:flags=lanczos[right]",
    canvas,
    "[canvas][left]overlay=x=40:y=48:shortest=1[withleft]",
    "[withleft][right]overlay=x=W-w-40:y=H-h-48:shortest=1[out]",
  ].join(";");
}

export async function renderNativeWindowVideo({
  composedPattern,
  destination,
  fps,
  frameCount,
  leftPattern,
  rightPattern,
  scenarioId,
}) {
  const ffmpeg = binary("DURE_MEDIA_FFMPEG_BIN", "ffmpeg");
  nativeWindowVideoEncoding(fps);
  await renderNativeWindowFrameSequence({
    composedPattern,
    frameCount,
    leftPattern,
    rightPattern,
    scenarioId,
  });
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-framerate",
      String(fps),
      "-start_number",
      "0",
      "-i",
      composedPattern,
      "-frames:v",
      String(frameCount),
      ...nativeWindowVideoEncodingOptions(fps),
      destination,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
  );
  return probeNativeWindowVideo({ destination, fps, frameCount });
}

export async function renderNativeWindowPlaceholder(destination) {
  const ffmpeg = binary("DURE_MEDIA_FFMPEG_BIN", "ffmpeg");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black@0.0:s=2x2,format=rgba",
      "-frames:v",
      "1",
      destination,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  );
}

export async function renderNativeWindowFrameSequence({
  composedPattern,
  frameCount,
  leftPattern,
  rightPattern,
  scenarioId,
}) {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 225) {
    throw new Error("native window frameCount must be from 1 to 225");
  }
  await mkdir(dirname(nativeWindowFramePath(composedPattern, 0)), {
    recursive: true,
    mode: 0o700,
  });
  for (let frame = 0; frame < frameCount; frame += 1) {
    await renderNativeWindowStill({
      destination: nativeWindowFramePath(composedPattern, frame),
      leftImage: nativeWindowFramePath(leftPattern, frame),
      rightImage: nativeWindowFramePath(rightPattern, frame),
      scenarioId,
    });
  }
}

export async function renderNativeWindowStill({
  destination,
  leftImage,
  rightImage,
  scenarioId,
}) {
  const ffmpeg = binary("DURE_MEDIA_FFMPEG_BIN", "ffmpeg");
  await execFileAsync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-loop",
      "1",
      "-i",
      leftImage,
      "-loop",
      "1",
      "-i",
      rightImage,
      "-filter_complex",
      nativeWindowCompositionFilter({ duration: 1, fps: 1, scenarioId }),
      "-map",
      "[out]",
      "-frames:v",
      "1",
      destination,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
  );
}

export async function probeNativeWindowVideo({ destination, fps, frameCount }) {
  const ffprobe = binary("DURE_MEDIA_FFPROBE_BIN", "ffprobe");
  const { stdout } = await execFileAsync(
    ffprobe,
    [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames",
      "-show_entries",
      "frame=key_frame",
      "-show_entries",
      "format=start_time,duration,size",
      "-of",
      "json",
      destination,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
  );
  const value = JSON.parse(stdout);
  return validateNativeWindowVideoProbe(value, { fps, frameCount });
}

export function validateNativeWindowVideoProbe(value, { fps, frameCount }) {
  const encoding = nativeWindowVideoEncoding(fps);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 225) {
    throw new Error("native window video frameCount must be from 1 to 225");
  }
  const stream = value.streams?.[0];
  const frames = value.frames;
  const keyFrameIndexes = Array.isArray(frames)
    ? frames.flatMap((frame, index) => (frame?.key_frame === 1 ? [index] : []))
    : [];
  const requiredKeyFrameIndexes = Array.from(
    { length: Math.ceil(frameCount / encoding.keyframeInterval) },
    (_, index) => index * encoding.keyframeInterval,
  );
  if (
    stream?.codec_name !== "vp9" ||
    stream.width !== 1920 ||
    stream.height !== 1080 ||
    stream.pix_fmt !== "yuv420p" ||
    stream.r_frame_rate !== `${fps}/1` ||
    Number(stream.nb_read_frames) !== frameCount ||
    frames?.length !== frameCount ||
    keyFrameIndexes.length !== requiredKeyFrameIndexes.length ||
    requiredKeyFrameIndexes.some(
      (requiredIndex, index) => keyFrameIndexes[index] !== requiredIndex,
    ) ||
    !Number.isFinite(Number(value.format?.duration)) ||
    Number(value.format.duration) <= 0 ||
    !Number.isSafeInteger(Number(value.format?.size)) ||
    Number(value.format.size) <= 0
  ) {
    throw new Error(`native window video probe failed: ${JSON.stringify(value)}`);
  }
  const { frames: _frames, ...boundedProbe } = value;
  return {
    ...boundedProbe,
    keyFrameIndexes,
  };
}
