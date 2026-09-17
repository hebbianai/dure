#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { observeProcessGeneration } from "../providers/process-generation.mjs";
import { scenarioById, validateScenario } from "../scenarios.mjs";
import {
  assertNativeRunDirectory,
  orderedFrameDigest,
  pngFileFacts,
  sha256File,
  writeJsonAtomic,
} from "./output.mjs";
import {
  nativeWindowVideoEncoding,
  renderNativeWindowPlaceholder,
  renderNativeWindowStill,
  renderNativeWindowVideo,
} from "./video.mjs";
import { nativeDesktopStageManifest } from "./desktop-stage.mjs";
import {
  expectedNativeWindowErrorTitles,
  expectedNativeInitialWindowTitles,
  expectedNativeWindowReplayTitles,
  expectedNativeWindowTitles,
  nativeWindowDeclarations,
} from "./window-contract.mjs";
import {
  captureWindowPng,
  matchingAvailableWindows,
  matchingReadyWindows,
  NativeWindowSetupError,
  probeMacosWindows,
  waitForReadyWindows,
} from "./window-probe.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name, minimum, maximum) {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requiredBoolean(name) {
  const value = required(name);
  if (value !== "0" && value !== "1") {
    throw new Error(`${name} must be 0 or 1`);
  }
  return value === "1";
}

async function waitForCapturableWindows(output, request) {
  try {
    return await waitForReadyWindows(request);
  } catch (error) {
    if (error instanceof NativeWindowSetupError) {
      const relativePath = `setup-error-${error.identity.label}.png`;
      try {
        await captureWindowPng(error.window.windowId, join(output, relativePath));
        error.message = `${error.message}; captured ${relativePath}`;
      } catch (captureError) {
        error.message = `${error.message}; error-window capture failed: ${String(captureError)}`;
      }
    }
    throw error;
  }
}

async function readDescriptor(home) {
  const path = resolve(home, ".hebbian", "server.json");
  const deadline = Date.now() + 180_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("native capture app descriptor must be a real file");
      }
      const descriptor = JSON.parse(await readFile(path, "utf8"));
      if (
        descriptor.schemaVersion !== 1 ||
        !Number.isSafeInteger(descriptor.processId) ||
        descriptor.processId <= 1 ||
        typeof descriptor.buildId !== "string" ||
        typeof descriptor.generation !== "string" ||
        typeof descriptor.packageVersion !== "string"
      ) {
        throw new Error("native capture app descriptor is invalid");
      }
      return { descriptor, path };
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`timed out waiting for native capture app descriptor: ${String(lastError)}`);
}

function sameWindow(before, after) {
  return (
    before.windowId === after.windowId &&
    before.ownerPid === after.ownerPid &&
    before.title === after.title &&
    JSON.stringify(before.bounds) === JSON.stringify(after.bounds)
  );
}

function sameWindowSurface(before, after) {
  return (
    before.windowId === after.windowId &&
    before.ownerPid === after.ownerPid &&
    JSON.stringify(before.bounds) === JSON.stringify(after.bounds)
  );
}

function frameGeometryTransitions(records, label) {
  const transitions = [];
  for (const record of records.filter(
    (candidate) => candidate.label === label && candidate.present,
  )) {
    const previous = transitions.at(-1);
    if (previous?.width === record.width && previous.height === record.height) {
      continue;
    }
    transitions.push({
      frame: record.frame,
      height: record.height,
      width: record.width,
    });
  }
  return transitions;
}

async function capture() {
  const output = await assertNativeRunDirectory(required("DURE_NATIVE_MEDIA_OUTPUT"));
  const proof = required("DURE_NATIVE_MEDIA_PROOF");
  const scenarioId = required("DURE_NATIVE_MEDIA_SCENARIO");
  const durationMs = boundedInteger("DURE_NATIVE_MEDIA_DURATION_MS", 1_000, 15_000);
  const fps = boundedInteger("DURE_NATIVE_MEDIA_FPS", 1, 15);
  const replayRequired = requiredBoolean(
    "DURE_NATIVE_MEDIA_REPLAY_REQUIRED",
  );
  const frameCount = Math.ceil((durationMs / 1_000) * fps);
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`native capture scenario is missing: ${scenarioId}`);
  const validationErrors = validateScenario(scenario);
  if (validationErrors.length > 0) {
    throw new Error(`native capture scenario is invalid: ${validationErrors.join("; ")}`);
  }

  const { descriptor, path: descriptorPath } = await readDescriptor(required("HOME"));
  const appProcess = {
    processId: descriptor.processId,
    startMarker: observeProcessGeneration(descriptor.processId),
  };
  if (!appProcess.startMarker) throw new Error("native capture app exited before window proof");
  const declarations = nativeWindowDeclarations(scenarioId);
  const expected = expectedNativeWindowTitles(proof, scenarioId);
  const expectedInitial = expectedNativeInitialWindowTitles(proof, scenarioId);
  const expectedReplay = expectedNativeWindowReplayTitles(proof, scenarioId);
  const expectedErrors = expectedNativeWindowErrorTitles(proof, scenarioId);
  const ready = await waitForCapturableWindows(output, {
    expected: expectedInitial,
    expectedErrors,
    processId: descriptor.processId,
  });
  const observedWindows = new Map(
    ready.windows.map((window) => [window.label, window]),
  );
  const frameRecords = [];
  const stills = [];
  for (const declaration of declarations) {
    const directory = join(output, "frames", declaration.label);
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const placeholderPath = join(output, "frames", "window-not-created.png");
  await renderNativeWindowPlaceholder(placeholderPath);
  const placeholder = await sha256File(placeholderPath);

  const startedAt = performance.now();
  for (let frame = 0; frame < frameCount; frame += 1) {
    const targetAt = startedAt + (frame * 1_000) / fps;
    const remaining = targetAt - performance.now();
    if (remaining > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
    }
    if (frame > 0 && observedWindows.size < declarations.length) {
      const probe = await probeMacosWindows(descriptor.processId);
      let available;
      try {
        available = matchingAvailableWindows(
          probe,
          [...expected, ...expectedReplay],
          expectedErrors,
        );
      } catch (error) {
        if (error instanceof NativeWindowSetupError) {
          const relativePath = `setup-error-${error.identity.label}.png`;
          await captureWindowPng(
            error.window.windowId,
            join(output, relativePath),
          ).catch(() => {});
          error.message = `${error.message}; captured ${relativePath}`;
        }
        throw error;
      }
      for (const window of available) {
        observedWindows.set(window.label, window);
      }
    }
    for (const declaration of declarations) {
      const window = observedWindows.get(declaration.label);
      const relativePath = `frames/${declaration.label}/${String(frame).padStart(5, "0")}.png`;
      const destination = join(output, relativePath);
      const image = window
        ? await captureWindowPng(window.windowId, destination)
        : { bytes: placeholder.bytes, height: 2, width: 2 };
      if (!window) await copyFile(placeholderPath, destination);
      frameRecords.push({
        ...(window ? await sha256File(destination) : placeholder),
        frame,
        height: image.height,
        label: declaration.label,
        present: Boolean(window),
        relativePath,
        width: image.width,
      });
    }
    if (frame === 0 && replayRequired) {
      await writeJsonAtomic(join(output, "replay-start.json"), {
        schemaVersion: 2,
        proof,
        startedAtUnixMs: Date.now(),
      });
    }
  }

  let replayComplete = null;
  if (replayRequired) {
    replayComplete = await waitForCapturableWindows(output, {
      expected: expectedReplay,
      expectedErrors,
      processId: descriptor.processId,
      timeoutMs: 10_000,
    });
    if (
      ready.windows.some((window) => {
        const completed = replayComplete.windows.find(
          (candidate) => candidate.label === window.label,
        );
        return !completed || !sameWindowSurface(window, completed);
      })
    ) {
      throw new Error("native window identity or bounds changed before replay completion");
    }
  }

  const completedWindows = replayComplete?.windows ?? ready.windows;
  if (
    completedWindows.length !== declarations.length ||
    declarations.some(({ label }) => !observedWindows.has(label))
  ) {
    throw new Error("native interaction window was not captured during recording");
  }
  const sessionDeclaration = declarations.find(
    ({ surface }) => surface === "session",
  );
  const maximizeActions = (scenario.timeline ?? []).filter(
    ({ action }) => action === "toggleWindowMaximize",
  );
  if (sessionDeclaration && maximizeActions.length > 0) {
    const transitions = frameGeometryTransitions(
      frameRecords,
      sessionDeclaration.label,
    );
    const first = transitions[0];
    const last = transitions.at(-1);
    if (
      transitions.length < 3 ||
      first.width !== last.width ||
      first.height !== last.height ||
      !transitions.slice(1, -1).some(
        ({ height, width }) => height !== first.height || width !== first.width,
      )
    ) {
      throw new Error("native maximize and restore geometry was not observed");
    }
  }

  for (const window of completedWindows) {
    const relativePath = `frames/${window.label}/still.png`;
    const destination = join(output, relativePath);
    const image = await captureWindowPng(window.windowId, destination);
    stills.push({
      ...image,
      ...(await sha256File(destination)),
      label: window.label,
      relativePath,
      windowId: window.windowId,
    });
  }
  const stillPath = join(output, `${scenarioId}.png`);
  await renderNativeWindowStill({
    destination: stillPath,
    leftImage: join(output, stills[0].relativePath),
    rightImage: join(output, stills[1].relativePath),
    scenarioId,
  });
  const composedStill = {
    relativePath: `${scenarioId}.png`,
    ...(await pngFileFacts(stillPath)),
  };

  const finalProbe = await probeMacosWindows(descriptor.processId);
  const finalExpected = replayRequired ? expectedReplay : expected;
  const finalWindows = matchingReadyWindows(
    finalProbe,
    finalExpected,
    expectedErrors,
  );
  const finalBaseline = completedWindows;
  if (
    finalBaseline.length !== finalWindows.length ||
    finalBaseline.some(
      (window, index) => !sameWindow(window, finalWindows[index]),
    )
  ) {
    throw new Error("native window identity or bounds changed during capture");
  }
  const videoPath = join(output, `${scenarioId}.webm`);
  const composedPattern = join(output, "frames", "composed", "%05d.png");
  const videoProbe = await renderNativeWindowVideo({
    composedPattern,
    destination: videoPath,
    fps,
    frameCount,
    leftPattern: join(output, "frames", declarations[0].label, "%05d.png"),
    rightPattern: join(output, "frames", declarations[1].label, "%05d.png"),
    scenarioId,
  });
  const video = await sha256File(videoPath);
  const capturedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    sourceKind: "native-tauri-window-only-v1",
    scenarioId,
    proof,
    capturedAt,
    descriptor: {
      schemaVersion: descriptor.schemaVersion,
      packageVersion: descriptor.packageVersion,
      buildId: descriptor.buildId,
      channel: descriptor.channel,
      generation: descriptor.generation,
      processId: descriptor.processId,
      pathKind: "isolated-home-server-descriptor",
    },
    appProcess,
    privacy: {
      capturePrimitive: "macos-screencapture-window-id",
      desktopPixelsIncluded: false,
      otherApplicationWindowsIncluded: false,
    },
    captureStage: nativeDesktopStageManifest({ fps, frameCount }),
    windows: completedWindows,
    stills,
    composedStill,
    recording: {
      requestedDurationMs: durationMs,
      elapsedMs: Math.round(performance.now() - startedAt),
      fps,
      frameCount,
      frameSetSha256: orderedFrameDigest(frameRecords),
      replayStart: replayRequired
        ? {
            afterFrame: 0,
            relativePath: "replay-start.json",
          }
        : null,
      replayCompletion: {
        required: replayRequired,
        observed: replayRequired ? true : null,
        windows: replayComplete?.windows ?? [],
      },
      windowLifecycle: {
        declarations: declarations.map(({ create, label, surface }) => ({
          creation: create ? "initial" : "interaction",
          label,
          surface,
        })),
        geometryTransitionsByWindow: Object.fromEntries(
          declarations.map(({ label }) => [
            label,
            frameGeometryTransitions(frameRecords, label),
          ]),
        ),
        firstCapturedFrameByWindow: Object.fromEntries(
          declarations.map(({ label }) => [
            label,
            frameRecords.find(
              (record) => record.label === label && record.present,
            )?.frame ?? null,
          ]),
        ),
      },
      distinctFrameCountByWindow: Object.fromEntries(
        declarations.map(({ label }) => [
          label,
          new Set(
            frameRecords
              .filter((record) => record.label === label && record.present)
              .map((record) => record.sha256),
          ).size,
        ]),
      ),
      video: {
        relativePath: `${scenarioId}.webm`,
        composition: {
          mode: "independent-full-frame-sequence",
          relativePattern: "frames/composed/%05d.png",
        },
        encoding: nativeWindowVideoEncoding(fps),
        ...video,
        probe: videoProbe,
      },
    },
    cleanup: {
      state: "pending_runner_exact_generation_cleanup",
      completionReceipt: "cleanup-receipt.json",
    },
    evidence: {
      descriptorPathKind: descriptorPath.endsWith("/.hebbian/server.json")
        ? "isolated-home"
        : "unexpected",
      initialProbeSha256: createHash("sha256")
        .update(JSON.stringify(ready.probe))
        .digest("hex"),
      finalProbeSha256: createHash("sha256")
        .update(JSON.stringify(finalProbe))
        .digest("hex"),
    },
  };
  await writeJsonAtomic(join(output, "manifest.json"), manifest);
  process.stdout.write(`${JSON.stringify({ output, video: videoPath })}\n`);
}

capture().catch((error) => {
  process.stderr.write(`native-media-client: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
