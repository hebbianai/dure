import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { reviewFrameRecord } from "./frame-analysis.mjs";
import { sha256FileEvidence } from "./file-digest.mjs";
import {
  assertReviewBaseline,
  reviewBaselineCandidate,
} from "./review-baseline.mjs";
import {
  buildReviewEvidence,
  validateRenderProbe,
} from "./review-evidence.mjs";

const execFileAsync = promisify(execFile);

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function verifyRenderEvidence(plan, mediaPath) {
  const sidecarBytes = await readFile(`${mediaPath}.json`);
  const evidence = JSON.parse(sidecarBytes.toString("utf8"));
  if (
    evidence?.schema !== "dure-remotion-render-evidence/v1" ||
    evidence.renderPlanSha256 !== plan.renderPlanSha256
  ) {
    throw new Error("render evidence does not match the storyboard plan");
  }
  const artifactEvidence = await sha256FileEvidence(mediaPath);
  if (
    evidence.artifact?.bytes !== artifactEvidence.bytes ||
    evidence.artifact?.sha256 !== artifactEvidence.sha256
  ) {
    throw new Error("rendered media bytes do not match their render evidence");
  }
  return {
    evidence,
    artifactEvidence,
    sidecarEvidence: {
      bytes: sidecarBytes.length,
      sha256: sha256Buffer(sidecarBytes),
    },
  };
}

async function probeRender(mediaPath, ffprobeBinary, signal) {
  const { stdout } = await execFileAsync(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate,nb_frames,nb_read_frames",
      "-of",
      "json",
      mediaPath,
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal, timeout: 30_000 },
  );
  return JSON.parse(stdout);
}

export function parseBlackFrameRecords(stderr, expectedFrameCount, blackRatio) {
  const records = [...stderr.matchAll(/frame:\s*(\d+)\s+pblack:\s*([0-9.]+)/gu)].map(
    (match) => ({ frame: Number(match[1]), blackRatio: Number(match[2]) / 100 }),
  );
  if (records.length !== expectedFrameCount) {
    throw new Error(
      `blank-frame scan produced ${records.length} records for ${expectedFrameCount} frames`,
    );
  }
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].frame !== index) {
      throw new Error(`blank-frame scan sequence is invalid at frame ${index}`);
    }
  }
  return {
    totalFrames: expectedFrameCount,
    frames: records
      .filter((record) => record.blackRatio >= blackRatio)
      .map((record) => record.frame),
  };
}

async function scanBlankFrames({
  mediaPath,
  plan,
  expectedFrameCount,
  ffmpegBinary,
  signal,
}) {
  const threshold = plan.review.blankFrame.lumaThreshold;
  const { stderr } = await execFileAsync(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      mediaPath,
      "-an",
      "-vf",
      `blackframe=amount=0:threshold=${threshold}`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal, timeout: 120_000 },
  );
  return parseBlackFrameRecords(
    stderr,
    expectedFrameCount,
    plan.review.blankFrame.blackRatio,
  );
}

async function extractFrame({
  mediaPath,
  frame,
  plan,
  outputPath,
  ffmpegBinary,
  signal,
}) {
  const selection = `select=eq(n\\,${frame})`;
  const common = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", mediaPath];
  await execFileAsync(
    ffmpegBinary,
    [
      ...common,
      "-vf",
      selection,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-y",
      outputPath,
    ],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, signal, timeout: 30_000 },
  );
  const { stdout } = await execFileAsync(
    ffmpegBinary,
    [
      ...common,
      "-vf",
      `${selection},format=gray`,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    {
      encoding: "buffer",
      maxBuffer: plan.target.width * plan.target.height + 1024,
      signal,
      timeout: 30_000,
    },
  );
  const grayFrame = new Uint8Array(stdout);
  if (grayFrame.length !== plan.target.width * plan.target.height) {
    throw new Error(`failed to extract complete review frame ${frame}`);
  }
  return grayFrame;
}

async function detectText(imagePath, tesseractBinary, signal) {
  if (!tesseractBinary) return "";
  const { stdout } = await execFileAsync(
    tesseractBinary,
    [imagePath, "stdout", "--psm", "6"],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, signal, timeout: 30_000 },
  );
  return stdout;
}

export async function preflightTesseract(tesseractBinary, signal) {
  const { stdout, stderr } = await execFileAsync(tesseractBinary, ["--version"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    signal,
    timeout: 10_000,
  });
  const output = `${stdout}\n${stderr}`.trim();
  const firstLine = output.split(/\r?\n/u)[0]?.trim() ?? "";
  if (!/^tesseract\s+\d+(?:\.\d+)+/iu.test(firstLine)) {
    throw new Error("OCR preflight did not identify a supported Tesseract binary");
  }
  return {
    engine: "tesseract",
    executable: basename(tesseractBinary),
    version: firstLine,
    fingerprintSha256: sha256Buffer(Buffer.from(output, "utf8")),
  };
}

export async function analyzeStoryboardRender({
  plan,
  mediaPath,
  reviewDirectory,
  baseline = null,
  ffmpegBinary = process.env.DURE_MEDIA_FFMPEG_BIN || "ffmpeg",
  ffprobeBinary = process.env.DURE_MEDIA_FFPROBE_BIN || "ffprobe",
  tesseractBinary = process.env.DURE_MEDIA_TESSERACT_BIN || null,
  signal,
}) {
  if (plan?.schema !== "dure-storyboard-render-plan/v1") {
    throw new Error("unsupported storyboard render plan");
  }
  if (baseline) assertReviewBaseline(baseline, plan);
  if (baseline && !tesseractBinary) {
    throw new Error("approved storyboard review requires OCR privacy evidence");
  }
  const ocrEngine = tesseractBinary
    ? await preflightTesseract(tesseractBinary, signal)
    : null;
  await mkdir(reviewDirectory, { recursive: true });
  const initialRenderProof = await verifyRenderEvidence(plan, mediaPath);
  const probe = await probeRender(mediaPath, ffprobeBinary, signal);
  const media = validateRenderProbe(probe, plan);
  const blankFrameScan = await scanBlankFrames({
    mediaPath,
    plan,
    expectedFrameCount: media.frameCount,
    ffmpegBinary,
    signal,
  });
  const baselineByFrame = new Map(
    (baseline?.frames ?? []).map((frame) => [frame.frame, frame.perceptualHash]),
  );
  const frames = [];
  for (const frame of plan.review.keyframes) {
    const imagePath = resolve(
      reviewDirectory,
      `frame-${String(frame).padStart(6, "0")}.png`,
    );
    const grayFrame = await extractFrame({
      mediaPath,
      frame,
      plan,
      outputPath: imagePath,
      ffmpegBinary,
      signal,
    });
    const detectedText = await detectText(imagePath, tesseractBinary, signal);
    if (tesseractBinary && detectedText.trim().length === 0) {
      throw new Error(`OCR returned no text for review frame ${frame}`);
    }
    frames.push(
      reviewFrameRecord({
        frame,
        grayFrame,
        width: plan.target.width,
        height: plan.target.height,
        lumaThreshold: plan.review.blankFrame.lumaThreshold,
        baselineHash: baselineByFrame.get(frame),
        detectedText,
      }),
    );
  }
  const finalRenderProof = await verifyRenderEvidence(plan, mediaPath);
  if (JSON.stringify(finalRenderProof) !== JSON.stringify(initialRenderProof)) {
    throw new Error("rendered media or render evidence changed during review");
  }
  const candidate = reviewBaselineCandidate(plan, frames);
  const privacyScan = tesseractBinary
    ? {
        method: "tesseract-keyframes",
        scope: "declared-review-keyframes",
        inspectedFrames: frames.length,
        engine: ocrEngine,
      }
    : null;
  return {
    candidate,
    evidence: baseline
      ? buildReviewEvidence({
          plan,
          probe,
          blankFrameScan,
          privacyScan,
          frames,
          artifactEvidence: initialRenderProof.artifactEvidence,
          renderEvidenceDigest: initialRenderProof.sidecarEvidence,
        })
      : null,
    frames,
    probe,
    blankFrameScan,
    privacyScan,
    renderEvidence: initialRenderProof.evidence,
    artifactEvidence: initialRenderProof.artifactEvidence,
    renderEvidenceDigest: initialRenderProof.sidecarEvidence,
  };
}
