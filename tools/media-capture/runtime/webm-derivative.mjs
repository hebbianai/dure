import {
  execFileAsync,
  ffmpegVersion,
  parseFrameRate,
} from "./ffmpeg-tools.mjs";
import { validatePublicWebmRecipe } from "./recipe-validation.mjs";

export { validatePublicWebmRecipe } from "./recipe-validation.mjs";

function seconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(3);
}

export function publicWebmRecipe(scenario) {
  const recipe = scenario.publicWebm;
  if (!recipe) {
    throw new Error(`${scenario.id} does not declare a publicWebm recipe`);
  }
  return structuredClone(recipe);
}

export function publicWebmFilterGraph(recipe) {
  const segments = recipe.segments.map(
    ({ startMs, endMs }, index) =>
      `[0:v]fps=fps=${recipe.fps}:round=near,trim=start=${seconds(startMs)}:end=${seconds(endMs)},setpts=PTS-STARTPTS[public_segment_${index}]`,
  );
  const timeline =
    recipe.segments.length === 1
      ? "[public_segment_0]null[public_timeline]"
      : `${recipe.segments.map((_, index) => `[public_segment_${index}]`).join("")}concat=n=${recipe.segments.length}:v=1:a=0[public_timeline]`;
  return [
    ...segments,
    timeline,
    `[public_timeline]scale=w=${recipe.width}:h=-2:flags=lanczos+accurate_rnd+bitexact,format=${recipe.pixelFormat}[public_output]`,
  ].join(";");
}

export function validatePublicWebmProbe(probe, recipe) {
  const stream = probe?.streams?.[0];
  const durationMs = Number(probe?.format?.duration) * 1_000;
  const expectedDurationMs = recipe.segments.reduce(
    (total, segment) => total + segment.endMs - segment.startMs,
    0,
  );
  const expectedFrames = Math.round((expectedDurationMs * recipe.fps) / 1_000);
  const actualFrames = Number(stream?.nb_read_frames);
  const frameRate = parseFrameRate(stream?.r_frame_rate);
  const startTimeMs = Number(probe?.format?.start_time) * 1_000;
  const errors = [];
  if (stream?.codec_name !== "vp9") errors.push("codec is not vp9");
  if (stream?.pix_fmt !== recipe.pixelFormat) {
    errors.push("pixel format does not match the recipe");
  }
  if (stream?.time_base !== recipe.timeBase) {
    errors.push("time base does not match the recipe");
  }
  if (stream?.width !== recipe.width || !Number.isInteger(stream?.height)) {
    errors.push("dimensions do not match the recipe");
  }
  if (!Number.isFinite(frameRate) || Math.abs(frameRate - recipe.fps) > 0.01) {
    errors.push("frame rate does not match the recipe");
  }
  if (actualFrames !== expectedFrames) {
    errors.push("frame count does not match the recipe");
  }
  if (
    !Number.isFinite(durationMs) ||
    Math.abs(durationMs - expectedDurationMs) > 150
  ) {
    errors.push("duration does not match the recipe");
  }
  if (!Number.isFinite(startTimeMs) || Math.abs(startTimeMs) > 40) {
    errors.push("timeline does not start at zero");
  }
  if (errors.length > 0) {
    throw new Error(`derived public WebM probe failed: ${errors.join(", ")}`);
  }
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    pixelFormat: stream.pix_fmt,
    frameRate: stream.r_frame_rate,
    timeBase: stream.time_base,
    frameCount: actualFrames,
    durationMs: Math.round(durationMs),
    startTimeMs: Math.round(startTimeMs),
  };
}

export function publicWebmRenderArgs(inputPath, outputPath, recipe) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-filter_complex_threads",
    "1",
    "-fflags",
    "+bitexact",
    "-i",
    inputPath,
    "-filter_complex",
    publicWebmFilterGraph(recipe),
    "-map",
    "[public_output]",
    "-an",
    "-fflags",
    "+bitexact",
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    recipe.pixelFormat,
    "-crf",
    String(recipe.crf),
    "-b:v",
    `${recipe.bitrateKbps}k`,
    "-deadline",
    recipe.deadline,
    "-cpu-used",
    String(recipe.cpuUsed),
    "-row-mt",
    String(recipe.rowMt),
    "-threads",
    String(recipe.threads),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-flags:v",
    "+bitexact",
    outputPath,
  ];
}

export async function renderPublicWebmDerivative({
  inputPath,
  outputPath,
  scenario,
  ffmpegBinary = process.env.DURE_MEDIA_FFMPEG_BIN || "ffmpeg",
  ffprobeBinary = process.env.DURE_MEDIA_FFPROBE_BIN || "ffprobe",
}) {
  const recipe = publicWebmRecipe(scenario);
  const recipeErrors = validatePublicWebmRecipe(recipe, scenario.durationMs);
  if (recipeErrors.length > 0) {
    throw new Error(recipeErrors.join("; "));
  }
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, abort);
  try {
    const encoder = await ffmpegVersion(
      ffmpegBinary,
      "public WebM generation",
      abortController.signal,
    );
    await execFileAsync(
      ffmpegBinary,
      publicWebmRenderArgs(inputPath, outputPath, recipe),
      {
        maxBuffer: 16 * 1024 * 1024,
        signal: abortController.signal,
        timeout: 120_000,
      },
    );
    const { stdout } = await execFileAsync(
      ffprobeBinary,
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,pix_fmt,r_frame_rate,time_base,nb_read_frames:format=start_time,duration",
        "-of",
        "json",
        outputPath,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        signal: abortController.signal,
        timeout: 10_000,
      },
    );
    return {
      schemaVersion: recipe.schemaVersion,
      recipe,
      encoder: { name: "ffmpeg", ...encoder },
      media: validatePublicWebmProbe(JSON.parse(stdout), recipe),
    };
  } catch (error) {
    throw new Error(
      `failed to derive verified public WebM for ${scenario.id}`,
      { cause: error },
    );
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.removeListener(signal, abort);
    }
  }
}
