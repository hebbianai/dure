#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { withoutLocalGitOverrides } from "../../scripts/lib/git-environment.mjs";
import {
  createLiveProviderMedia,
  fixtureProviderMedia,
} from "./providers/live-sessions.mjs";
import { exactProcessGenerationStatus } from "./providers/process-generation.mjs";
import { providerProvenance } from "./providers/provenance.mjs";
import { scenarioById, validateScenario } from "./scenarios.mjs";
import { runTerminalSurfaceProof } from "./native/terminal-surface-proof.mjs";
import { nativeDesktopStageManifest } from "./native/desktop-stage.mjs";
import { nativeMediaRunnerEnvironment } from "./native/environment.mjs";
import {
  nativeHmuxRuntimeEnvironment,
  stageNativeHmuxRuntime,
} from "./native/runtime-binaries.mjs";
import {
  createNativeRunDirectory,
  publishVerifiedNativeSource,
  sha256File,
  writeJsonAtomic,
} from "./native/output.mjs";
import { encodeNativeSnapshotOverride } from "./native/snapshot-override.mjs";
import {
  nativeBlankReplayScenario,
  nativeLiveReplaySteps,
} from "./native/replay.mjs";
import { nativeScenarioTimelineActions } from "./native/scenario-runtime.mjs";
import { nativeWindowPlan } from "./native/window-contract.mjs";
import { applicationWorkingTreeState } from "./runtime/application-build.mjs";
import {
  captureProofManifest,
  captureProofRequirements,
} from "./runtime/capture-proof.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");

function replayControlUrl(runRoot) {
  const relativeRunRoot = relative(repoRoot, runRoot).replaceAll("\\", "/");
  if (!relativeRunRoot.startsWith("output/playwright/native-multi-window/")) {
    throw new Error("native replay control path escaped the ignored output root");
  }
  return `/${relativeRunRoot}/replay-start.json`;
}

function parseArguments(args) {
  const options = {
    durationMs: 3_000,
    fps: 6,
    providerSource: undefined,
    requireLiveProviders: false,
    scenarioId: "workspace-overview",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (
      ["--duration-ms", "--fps", "--provider-source", "--scenario"].includes(
        argument,
      )
    ) {
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--duration-ms") options.durationMs = Number(value);
      if (argument === "--fps") options.fps = Number(value);
      if (argument === "--provider-source") options.providerSource = value;
      if (argument === "--scenario") options.scenarioId = value;
      continue;
    }
    if (argument === "--require-live-providers") {
      options.requireLiveProviders = true;
      continue;
    }
    throw new Error(`unknown native media argument: ${argument}`);
  }
  if (
    !Number.isInteger(options.durationMs) ||
    options.durationMs < 1_000 ||
    options.durationMs > 15_000
  ) {
    throw new Error("--duration-ms must be an integer from 1000 to 15000");
  }
  if (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 15) {
    throw new Error("--fps must be an integer from 1 to 15");
  }
  if (
    options.providerSource !== undefined &&
    !["fixture", "live"].includes(options.providerSource)
  ) {
    throw new Error("--provider-source must be live or fixture");
  }
  if (options.requireLiveProviders && options.providerSource === "fixture") {
    throw new Error("--require-live-providers conflicts with fixture provider source");
  }
  return options;
}

async function sourceRevision() {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  });
  return stdout.trim();
}

async function runNativeApp({
  baseEnvironment,
  options,
  plan,
  proof,
  replayRequired,
  runRoot,
  snapshotOverride,
}) {
  const runner = resolve(import.meta.dirname, "native", "run.sh");
  const child = spawn("sh", [runner], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: nativeMediaRunnerEnvironment({
      baseEnvironment,
      durationMs: options.durationMs,
      fps: options.fps,
      output: runRoot,
      plan,
      proof,
      replayRequired,
      scenarioId: options.scenarioId,
      snapshotOverride,
    }),
    stdio: "inherit",
  });
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTermination);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`native media runner exited with ${signal}`));
        else resolveExit(code ?? 1);
      });
    });
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  }
}

async function run() {
  if (process.platform !== "darwin") {
    throw new Error("native multi-window media currently requires macOS");
  }
  const options = parseArguments(process.argv.slice(2));
  const scenario = scenarioById(options.scenarioId);
  if (!scenario) throw new Error(`native media scenario is missing: ${options.scenarioId}`);
  const validationErrors = validateScenario(scenario);
  if (validationErrors.length > 0) {
    throw new Error(`native media scenario is invalid: ${validationErrors.join("; ")}`);
  }
  const proofRequirements = captureProofRequirements(scenario);
  options.providerSource ??=
    proofRequirements.requiredProviderSource ?? "fixture";
  if (
    proofRequirements.requiredProviderSource !== null &&
    options.providerSource !== proofRequirements.requiredProviderSource
  ) {
    throw new Error(
      `${proofRequirements.profile} requires --provider-source ${proofRequirements.requiredProviderSource}`,
    );
  }

  const proof = randomBytes(16).toString("hex");
  const { runId, runRoot } = await createNativeRunDirectory({
    proof,
    scenarioId: options.scenarioId,
  });
  const workingTreeBefore = await applicationWorkingTreeState();
  const workingTreeFingerprintBefore = workingTreeBefore.fingerprint;
  const revision = await sourceRevision();
  const terminalSurfaceProof = proofRequirements.requiresTerminalSurfaceProof
    ? await runTerminalSurfaceProof({
        failurePath: join(runRoot, "terminal-surface-proof-failure.json"),
        sourceRevision: revision,
        workingTreeFingerprint: workingTreeFingerprintBefore,
      })
    : null;
  const captureEnvironment =
    options.providerSource === "live"
      ? nativeHmuxRuntimeEnvironment(
          process.env,
          await stageNativeHmuxRuntime(),
        )
      : process.env;
  let providerMedia;
  let runnerExitCode;
  let replaySteps = [];
  let nativeTimelineActions = [];
  try {
    providerMedia =
      options.providerSource === "live"
        ? await createLiveProviderMedia({
            env: captureEnvironment,
            progress: (message) => process.stderr.write(`native-media: ${message}\n`),
            requireLiveProviders:
              options.requireLiveProviders || proofRequirements.requiresLiveContinuity,
            scenario,
          })
        : fixtureProviderMedia(scenario);
    if (proofRequirements.requiresLiveContinuity && options.providerSource === "live") {
      await providerMedia.probeLiveSessions({
        captureKind: "native-multiple-views",
        phase: "before",
      });
    }
    replaySteps =
      options.providerSource === "live"
        ? nativeLiveReplaySteps(
            providerMedia.replayBySession,
            options.durationMs,
          )
        : [];
    if (
      proofRequirements.requiresLiveContinuity &&
      options.providerSource === "live" &&
      replaySteps.length < 2
    ) {
      throw new Error("native live media requires at least two provider replay frames");
    }
    nativeTimelineActions = nativeScenarioTimelineActions(scenario);
    if (nativeTimelineActions.length > 0) {
      if (replaySteps.length === 0) {
        throw new Error("native interaction timeline requires a replay start boundary");
      }
      const lastActionAtMs = Math.max(
        ...nativeTimelineActions.map(({ atMs }) => atMs),
      );
      if (lastActionAtMs >= options.durationMs) {
        throw new Error("native interaction timeline exceeds the recording duration");
      }
    }
    const captureScenario =
      replaySteps.length > 0
        ? nativeBlankReplayScenario(
            providerMedia.videoScenario,
            providerMedia.replayBySession,
          )
        : providerMedia.stillScenario;
    const plan = nativeWindowPlan({
      proof,
      scenarioId: options.scenarioId,
    });
    runnerExitCode = await runNativeApp({
      baseEnvironment: captureEnvironment,
      options,
      plan,
      proof,
      replayRequired: replaySteps.length > 0,
      runRoot,
      snapshotOverride:
        options.providerSource === "live"
          ? encodeNativeSnapshotOverride(
              captureScenario,
              replaySteps,
              replaySteps.length > 0 ? replayControlUrl(runRoot) : null,
            )
          : undefined,
    });
    if (runnerExitCode !== 0) {
      throw new Error(
        `native media runner failed with exit code ${runnerExitCode}; inspect ${runRoot}`,
      );
    }
    if (proofRequirements.requiresLiveContinuity && options.providerSource === "live") {
      await providerMedia.probeLiveSessions({
        captureKind: "native-multiple-views",
        phase: "after",
      });
    }
  } finally {
    await providerMedia?.close();
  }

  const workingTreeAfter = await applicationWorkingTreeState();
  const workingTreeFingerprintAfter = workingTreeAfter.fingerprint;
  if (workingTreeFingerprintBefore !== workingTreeFingerprintAfter) {
    throw new Error("application working tree changed during native media capture");
  }
  const manifestPath = join(runRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.proof !== proof || manifest.scenarioId !== options.scenarioId) {
    throw new Error("native media manifest does not bind the requested run");
  }
  const frameCount = Math.ceil((options.durationMs / 1_000) * options.fps);
  const captureStage = nativeDesktopStageManifest({
    fps: options.fps,
    frameCount,
  });
  if (JSON.stringify(manifest.captureStage) !== JSON.stringify(captureStage)) {
    throw new Error("native media manifest does not bind the generated desktop stage");
  }
  const distinctFrameCounts = Object.values(
    manifest.recording?.distinctFrameCountByWindow ?? {},
  );
  const minimumDistinctFrames = Math.min(3, replaySteps.length);
  const visibleMotionObservedInEveryWindow =
    replaySteps.length > 0 &&
    distinctFrameCounts.length === manifest.windows?.length &&
    distinctFrameCounts.every(
      (count) =>
        Number.isSafeInteger(count) && count >= minimumDistinctFrames,
    );
  if (replaySteps.length > 1 && !visibleMotionObservedInEveryWindow) {
    throw new Error("native terminal replay produced no visible motion in a product window");
  }
  const processStatus = exactProcessGenerationStatus(manifest.appProcess);
  if (processStatus === "live") {
    throw new Error("native media app generation survived verified runner cleanup");
  }
  const provenance = providerProvenance(providerMedia);
  manifest.schemaVersion = 3;
  manifest.sourceKind =
    options.providerSource === "live"
      ? "native-tauri-windows-live-hmux-snapshot-v1"
      : "native-tauri-windows-fixture-snapshot-v1";
  manifest.applicationSource = {
    sourceRevision: revision,
    workingTreeFingerprint: workingTreeFingerprintAfter,
    dirty: workingTreeAfter.dirty,
  };
  manifest.providerSource = options.providerSource;
  manifest.captureStage = captureStage;
  Object.assign(manifest, provenance);
  manifest.captureProof = captureProofManifest({
    captureSurface: "native-tauri",
    continuityEvidence: providerMedia.continuityEvidence ?? [],
    terminalSurfaceProof,
    providerSource: options.providerSource,
    scenario,
  });
  manifest.terminalReplay = {
    requested: replaySteps.length > 0,
    source:
      replaySteps.length > 0 ? "sanitized-live-hmux-frames-v1" : "none",
    stepCount: replaySteps.length,
    visibleMotionObservedInEveryWindow,
    startBoundary: replaySteps.length > 0 ? "after-first-window-frame-v1" : "none",
    scheduleSha256: createHash("sha256")
      .update("dure-native-terminal-replay-v1\0")
      .update(JSON.stringify(replaySteps))
      .digest("hex"),
  };
  manifest.interactionTimeline = {
    requested: nativeTimelineActions.length > 0,
    source:
      nativeTimelineActions.length > 0 ? "scenario-timeline-v1" : "none",
    actionCount: nativeTimelineActions.length,
    actionKinds: [...new Set(nativeTimelineActions.map(({ action }) => action))],
    completionBoundary:
      nativeTimelineActions.length > 0
        ? "desktop-replay-complete-title-v1"
        : "none",
    scheduleSha256: createHash("sha256")
      .update("dure-native-interaction-timeline-v1\0")
      .update(JSON.stringify(nativeTimelineActions))
      .digest("hex"),
  };
  await writeJsonAtomic(manifestPath, manifest);
  const manifestDigest = await sha256File(manifestPath);
  const receipt = {
    schemaVersion: 1,
    runId,
    scenarioId: options.scenarioId,
    proof,
    completedAt: new Date().toISOString(),
    runnerExitCode,
    appProcessFinalStatus: processStatus,
    cleanupVerified: true,
    workingTreeFingerprint: workingTreeFingerprintAfter,
    manifest: manifestDigest,
  };
  await writeJsonAtomic(join(runRoot, "cleanup-receipt.json"), receipt);
  const selection = workingTreeAfter.dirty
    ? null
    : await publishVerifiedNativeSource({
        runId,
        runRoot,
        scenarioId: options.scenarioId,
      });
  process.stdout.write(
    `${JSON.stringify({
      output: runRoot,
      receipt,
      selection,
      still: join(runRoot, `${options.scenarioId}.png`),
      video: join(runRoot, `${options.scenarioId}.webm`),
    })}\n`,
  );
}

run().catch((error) => {
  process.stderr.write(`native-media: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
