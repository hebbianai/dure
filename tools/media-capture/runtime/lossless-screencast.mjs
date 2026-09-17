import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { recordedProductTourInput } from "./product-tour-effects.mjs";
import { execFileAsync, ffmpegVersion } from "./ffmpeg-tools.mjs";

export function frameTimeline(timestamps, duration) {
  if (!timestamps.length || !Number.isFinite(duration) || duration <= 0 ||
      timestamps.some((at, i) => !Number.isFinite(at) || (i > 0 && at <= timestamps[i - 1])) ||
      timestamps.at(-1) - timestamps[0] >= duration) {
    throw new Error("Screencast requires ordered frames inside its recording duration");
  }
  const rows = timestamps.map((at, i) => {
    const next = timestamps[i + 1] ?? timestamps[0] + duration;
    return `file '${i}.png'\noption framerate 60\nduration ${(next - at).toFixed(6)}`;
  });
  return `ffconcat version 1.0\n${rows.join("\n")}\nfile '${timestamps.length - 1}.png'\noption framerate 60\n`;
}

// ponytail: retain PNG frames for these short clips; stream to an encoder for long recordings.
export async function startLosslessScreencast(page, destination, viewport) {
  const ffmpeg = process.env.DURE_MEDIA_FFMPEG_BIN || "ffmpeg";
  const encoder = await ffmpegVersion(ffmpeg, "Retina capture");
  const framesDirectory = resolve(dirname(destination), "frames");
  await mkdir(framesDirectory);
  const size = { width: viewport.width * viewport.deviceScaleFactor, height: viewport.height * viewport.deviceScaleFactor };
  const session = await page.context().newCDPSession(page);
  const timestamps = [];
  let pending = Promise.resolve();
  let failure;
  let firstArrival;
  let resolveFirst;
  let rejectFirst;
  const firstFrame = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  session.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    pending = pending.then(async () => {
      if (!Number.isFinite(metadata.timestamp)) throw new Error("Screencast frame is missing its timestamp");
      const bytes = Buffer.from(data, "base64");
      if (bytes.readUInt32BE(16) !== size.width || bytes.readUInt32BE(20) !== size.height) {
        throw new Error("Screencast pixels do not match the requested Retina size");
      }
      if (metadata.timestamp > (timestamps.at(-1) ?? -Infinity)) {
        firstArrival ??= performance.now();
        await writeFile(resolve(framesDirectory, `${timestamps.length}.png`), bytes);
        timestamps.push(metadata.timestamp);
      }
      await session.send("Page.screencastFrameAck", { sessionId });
      resolveFirst();
    }).catch((error) => { failure ??= error; rejectFirst(error); });
  });
  let timer;
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      ...viewport, mobile: false,
      viewport: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 1 },
    });
    timer = setTimeout(() => rejectFirst(new Error("Screencast did not produce its first frame")), 5000);
    await Promise.all([
      firstFrame,
      session.send("Page.startScreencast", { format: "png", maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 }),
    ]);
  } catch (error) {
    await session.detach();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return async (encode = true) => {
    try {
      await session.send("Page.stopScreencast");
      await pending;
    } finally {
      await session.detach();
    }
    if (!encode) return;
    if (failure) throw failure;
    const duration = Math.max((performance.now() - firstArrival) / 1000, timestamps.at(-1) - timestamps[0] + 1 / 60);
    const input = await recordedProductTourInput(page, timestamps[0], duration);
    await writeFile(resolve(framesDirectory, "timeline.ffconcat"), frameTimeline(timestamps, duration));
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", "timeline.ffconcat",
      "-vf", "fps=60", "-t", duration.toFixed(6), "-fps_mode", "cfr", "-an", "-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "gbrp",
      "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8", "-lag-in-frames", "0", "-row-mt", "1", "-threads", "4", "-y", destination];
    await execFileAsync(ffmpeg, args, { cwd: framesDirectory, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    return { sourceFormat: "png", sourceFrames: timestamps.length, frameDirectory: "frames", size, timeBase: "1/60", cadence: "constant", ...(input ? { input } : {}),
      codec: "vp9", lossless: true, pixelFormat: "gbrp", durationSeconds: duration, encoder };
  };
}
