import {
  execFileAsync,
  ffmpegVersion,
  parseFrameRate,
} from "./ffmpeg-tools.mjs";
import { validateReadmeGifRecipe } from "./recipe-validation.mjs";

export { validateReadmeGifRecipe } from "./recipe-validation.mjs";

function seconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(3);
}

export function readmeGifRecipe(scenario) {
  const recipe = scenario.readmeGif;
  if (!recipe) {
    throw new Error(`${scenario.id} does not declare a readmeGif recipe`);
  }
  return structuredClone(recipe);
}

export function gifFilterGraph(recipe) {
  const segments = recipe.segments.map(
    ({ startMs, endMs }, index) =>
      `[0:v]trim=start=${seconds(startMs)}:end=${seconds(endMs)},setpts=PTS-STARTPTS[gif_segment_${index}]`,
  );
  const timeline =
    recipe.segments.length === 1
      ? "[gif_segment_0]null[gif_timeline]"
      : `${recipe.segments.map((_, index) => `[gif_segment_${index}]`).join("")}concat=n=${recipe.segments.length}:v=1:a=0[gif_timeline]`;
  return [
    ...segments,
    timeline,
    `[gif_timeline]fps=fps=${recipe.fps}:round=near,scale=w=${recipe.width}:h=-2:flags=lanczos+accurate_rnd+bitexact,split[gif_frames][gif_palette_source]`,
    `[gif_palette_source]palettegen=max_colors=${recipe.maxColors}:stats_mode=full[gif_palette]`,
    "[gif_frames][gif_palette]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[gif_output]",
  ].join(";");
}

export function validateGifProbe(probe, recipe) {
  const stream = probe?.streams?.[0];
  const durationMs = Number(probe?.format?.duration) * 1_000;
  const expectedDurationMs = recipe.segments.reduce(
    (total, segment) => total + segment.endMs - segment.startMs,
    0,
  );
  const expectedFrames = Math.round((expectedDurationMs * recipe.fps) / 1_000);
  const actualFrames = Number(stream?.nb_frames);
  const errors = [];
  if (stream?.codec_name !== "gif") errors.push("codec is not gif");
  if (stream?.width !== recipe.width || !Number.isInteger(stream?.height)) {
    errors.push("dimensions do not match the recipe");
  }
  const frameRate = parseFrameRate(stream?.r_frame_rate);
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
  if (errors.length > 0) {
    throw new Error(`derived GIF probe failed: ${errors.join(", ")}`);
  }
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    frameRate: stream.r_frame_rate,
    frameCount: actualFrames,
    durationMs: Math.round(durationMs),
  };
}

export async function renderGifDerivative({
  inputPath,
  outputPath,
  scenario,
  ffmpegBinary = process.env.DURE_MEDIA_FFMPEG_BIN || "ffmpeg",
  ffprobeBinary = process.env.DURE_MEDIA_FFPROBE_BIN || "ffprobe",
}) {
  const recipe = readmeGifRecipe(scenario);
  const recipeErrors = validateReadmeGifRecipe(recipe, scenario.durationMs);
  if (recipeErrors.length > 0) {
    throw new Error(recipeErrors.join("; "));
  }
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, abort);
  }
  try {
    const encoder = await ffmpegVersion(
      ffmpegBinary,
      "README GIF generation",
      abortController.signal,
    );
    await execFileAsync(
      ffmpegBinary,
      [
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
        gifFilterGraph(recipe),
        "-map",
        "[gif_output]",
        "-an",
        "-loop",
        String(recipe.loop),
        "-gifflags",
        "+transdiff",
        "-threads",
        "1",
        "-map_metadata",
        "-1",
        "-flags:v",
        "+bitexact",
        outputPath,
      ],
      {
        maxBuffer: 16 * 1024 * 1024,
        signal: abortController.signal,
        timeout: 60_000,
      },
    );
    const { stdout } = await execFileAsync(
      ffprobeBinary,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration",
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
      encoder: {
        name: "ffmpeg",
        ...encoder,
      },
      media: validateGifProbe(JSON.parse(stdout), recipe),
    };
  } catch (error) {
    throw new Error(`failed to derive verified README GIF for ${scenario.id}`, {
      cause: error,
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.removeListener(signal, abort);
    }
  }
}
