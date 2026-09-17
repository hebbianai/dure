#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import {
  makeCancelSignal,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import { sha256FileEvidence } from "../file-digest.mjs";
import { verifyRenderSources } from "../render-sources.mjs";
import { transientOutputRoot } from "../../paths.mjs";
import {
  ensureSafeOutputDirectory,
  resolveSafeExistingDirectory,
} from "../secure-output.mjs";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const allowedOutputRoot = resolve(repoRoot, "output/playwright/storyboards");

function assertContained(root, candidate, label) {
  const pathFromRoot = relative(root, candidate);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, pathFromRoot) !== candidate
  ) {
    throw new Error(`${label} must stay below ${root}`);
  }
}

function codecFor(target) {
  const supported = {
    gif: ["gif"],
    mp4: ["h264"],
    webm: ["vp8", "vp9"],
  };
  if (!supported[target.format]?.includes(target.codec)) {
    throw new Error(
      `unsupported Remotion codec ${target.codec} for ${target.format}`,
    );
  }
  return target.codec;
}

export async function renderStoryboardWithRemotion({
  plan,
  captureRoot,
  outputPath,
  publishedOutputPath = outputPath,
  progress = () => {},
}) {
  if (plan?.schema !== "dure-remotion-props/v1") {
    throw new Error("unsupported Remotion render plan");
  }
  const resolvedCaptureRoot = await resolveSafeExistingDirectory({
    allowedRoot: transientOutputRoot,
    directory: captureRoot,
    label: "Remotion capture root",
  });
  const resolvedOutput = resolve(outputPath);
  const resolvedPublishedOutput = resolve(publishedOutputPath);
  assertContained(allowedOutputRoot, resolvedOutput, "Remotion output");
  assertContained(
    allowedOutputRoot,
    resolvedPublishedOutput,
    "Remotion published output",
  );
  if (extname(resolvedOutput) !== `.${plan.inputProps.target.format}`) {
    throw new Error("Remotion output extension does not match the target format");
  }
  await ensureSafeOutputDirectory({
    allowedRoot: repoRoot,
    directory: dirname(resolvedOutput),
    label: "Remotion output directory",
  });
  const [resolvedAllowedRoot, resolvedOutputDirectory] = await Promise.all([
    realpath(allowedOutputRoot),
    realpath(dirname(resolvedOutput)),
  ]);
  assertContained(
    resolvedAllowedRoot,
    resolvedOutputDirectory,
    "Remotion output directory",
  );
  const extension = extname(resolvedOutput);
  const temporaryOutput = `${resolvedOutput.slice(0, -extension.length)}.${process.pid}.${randomUUID()}.partial${extension}`;
  const sidecarPath = `${resolvedOutput}.json`;
  const temporarySidecar = `${sidecarPath}.${process.pid}.${randomUUID()}.partial`;
  const bundleDirectory = await mkdtemp(resolve(tmpdir(), "dure-remotion-bundle-"));
  const startedAt = performance.now();
  const { cancel, cancelSignal } = makeCancelSignal();
  let aborted = false;
  const abort = () => {
    aborted = true;
    cancel();
  };
  const throwIfAborted = () => {
    if (aborted) throw new Error("Remotion storyboard render was interrupted");
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, abort);
  try {
    await verifyRenderSources({
      sources: plan.inputProps.sources,
      captureRoot: resolvedCaptureRoot,
    });
    progress("bundling Remotion storyboard");
    let lastBundleProgress = -1;
    const serveUrl = await bundle({
      entryPoint: resolve(import.meta.dirname, "src", "index.jsx"),
      outDir: bundleDirectory,
      publicDir: resolvedCaptureRoot,
      onProgress: (value) => {
        throwIfAborted();
        const percentage = Math.round(value <= 1 ? value * 100 : value);
        if (percentage !== lastBundleProgress) {
          lastBundleProgress = percentage;
          progress(`bundle ${percentage}%`);
        }
      },
    });
    throwIfAborted();
    const composition = await selectComposition({
      serveUrl,
      id: plan.compositionId,
      inputProps: plan.inputProps,
      logLevel: "warn",
    });
    throwIfAborted();
    progress(`rendering ${composition.durationInFrames} frames`);
    let lastRenderProgress = -1;
    const guided = plan.inputProps.sources.some((source) => source.input);
    const renderThreads = guided ? 2 : 1;
    const quality = plan.inputProps.target.codec === "h264" && guided ? { crf: 12 } : {};
    await renderMedia({
      ...quality,
      composition,
      serveUrl,
      codec: codecFor(plan.inputProps.target),
      outputLocation: temporaryOutput,
      inputProps: plan.inputProps,
      cancelSignal,
      concurrency: renderThreads,
      disallowParallelEncoding: true,
      offthreadVideoThreads: renderThreads,
      imageFormat: "png",
      muted: true,
      overwrite: true,
      colorSpace: "bt709",
      numberOfGifLoops:
        plan.inputProps.target.format === "gif" ? null : undefined,
      onProgress: ({ progress: value }) => {
        const percentage = Math.round(value * 100);
        if (percentage !== lastRenderProgress) {
          lastRenderProgress = percentage;
          progress(`render ${percentage}%`);
        }
      },
    });
    throwIfAborted();
    await verifyRenderSources({
      sources: plan.inputProps.sources,
      captureRoot: resolvedCaptureRoot,
    });
    throwIfAborted();
    await rename(temporaryOutput, resolvedOutput);
    throwIfAborted();
    const artifactEvidence = await sha256FileEvidence(resolvedOutput);
    throwIfAborted();
    const evidence = {
      schema: "dure-remotion-render-evidence/v1",
      remotionVersion: "4.0.503",
      renderPlanSha256: plan.inputProps.renderPlanSha256,
      elapsedMs: Math.round(performance.now() - startedAt),
      settings: {
        ...quality,
        codec: plan.inputProps.target.codec,
        colorSpace: "bt709",
        concurrency: renderThreads,
        disallowParallelEncoding: true,
        imageFormat: "png",
        offthreadVideoThreads: renderThreads,
      },
      artifact: {
        path: relative(repoRoot, resolvedPublishedOutput),
        ...artifactEvidence,
      },
    };
    const sidecarHandle = await open(temporarySidecar, "wx", 0o600);
    try {
      await sidecarHandle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
      await sidecarHandle.sync();
    } finally {
      await sidecarHandle.close();
    }
    throwIfAborted();
    await rename(temporarySidecar, sidecarPath);
    throwIfAborted();
    return evidence;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.removeListener(signal, abort);
    }
    await rm(temporaryOutput, { force: true });
    await rm(temporarySidecar, { force: true });
    await rm(bundleDirectory, { recursive: true, force: true });
  }
}
