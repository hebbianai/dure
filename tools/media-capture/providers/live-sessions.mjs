import { floatingReplayVisibility, replayVisibility } from "./replay-visibility.mjs";
export { replayVisibility } from "./replay-visibility.mjs";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  createProviderDemoRepo,
  createProviderDemoWorktree,
} from "./demo-repo.mjs";
import {
  ProviderAuthenticationRequiredError,
  UnsafeProviderOutputError,
  assertProviderScreenSafe,
  normalizeProviderScreen,
  visibleProviderText,
} from "./privacy.mjs";
import {
  liveProvidersForScenario,
  providersForScenario,
  providerSpec,
  sessionTargetsForProvider,
} from "./specs.mjs";
import {
  providerScreenReady,
  providerStartupKeys,
} from "./startup-prompts.mjs";
import { providerResponseComplete } from "./response-completion.mjs";
import { providerFixtureRoot, repoRoot } from "../paths.mjs";
import { captureProofNeedsLiveContinuity } from "../runtime/capture-proof.mjs";
import {
  assertOwnedProviderFixture,
  claimCleanupLedger,
  recoverableCleanupLedgers,
  removeCleanupLedger,
  writeCleanupLedger,
} from "./cleanup-ledger.mjs";
import {
  resizeHmuxSession,
  terminalCaptureSize,
} from "./terminal-geometry.mjs";
import {
  capturePaneSizedFrames,
  dedicatedTargetsForProvider,
  framesForSessionTarget,
  primaryTerminalSize,
} from "./pane-sized-sessions.mjs";
import {
  prepareProviderAutomationState,
  providerAutomationCommand,
  retireProviderAutomationCredentials,
} from "./codex-automation-home.mjs";
export { framesForSessionTarget } from "./pane-sized-sessions.mjs";

const execFileAsync = promisify(execFile);
const FENCE_FIELDS = Object.freeze([
  "workspace_id",
  "session_id",
  "runner_principal",
  "runner_instance",
  "channel_epoch",
  "host_instance_id",
  "terminal_epoch",
]);
const DEFAULT_SAMPLE_MS = 45_000;
const SAMPLE_INTERVAL_MS = 400;
const REQUIRED_HMUX_CAPABILITIES = Object.freeze([
  "managed_screen_read_v1",
  "generation_fenced_kill_v1",
  "process_generation_probe_v1",
]);

export class ProviderUnavailableError extends Error {
  constructor(provider, reason) {
    super(`live ${provider} provider unavailable: ${reason}`);
    this.name = "ProviderUnavailableError";
    this.provider = provider;
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function sampleDurationMs(env) {
  const requested = Number.parseInt(env.DURE_MEDIA_LIVE_SAMPLE_MS ?? "", 10);
  if (!Number.isFinite(requested)) return DEFAULT_SAMPLE_MS;
  return Math.min(60_000, Math.max(2_000, requested));
}

async function executablePath(command, env) {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking along PATH.
    }
  }
  return null;
}

async function defaultRun(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

export function assertCompatibleHmuxCapabilities(receipt) {
  if (
    receipt?.schemaVersion !== 2 ||
    !Array.isArray(receipt.capabilities) ||
    !REQUIRED_HMUX_CAPABILITIES.every((capability) =>
      receipt.capabilities.includes(capability),
    )
  ) {
    throw new Error(
      `hmux is missing media-capture capabilities: ${REQUIRED_HMUX_CAPABILITIES.join(", ")}`,
    );
  }
  return receipt;
}

async function preflightHmux(hmux, env, run) {
  const receipt = await run(hmux, ["--json", "capabilities"], {
    env,
    timeoutMs: 5_000,
  });
  return assertCompatibleHmuxCapabilities(
    parseJson(receipt.stdout, "hmux capabilities"),
  );
}

function hmuxArgs(discoveryRoot, command, args = []) {
  return ["--discovery-root", discoveryRoot, "--json", command, ...args];
}

export function fenceFromSessionRecord(record) {
  const fence = {};
  for (const field of FENCE_FIELDS) {
    if (record?.[field] === undefined || record[field] === null) {
      throw new Error(`hmux session record is missing fence field ${field}`);
    }
    fence[field] = record[field];
  }
  return fence;
}

export function decodeHmuxScreen(
  provider,
  receipt,
  home,
  fixture,
  workingDirectory,
) {
  if (
    receipt?.ok !== true ||
    receipt.encoding !== "AnsiRedrawV1" ||
    typeof receipt.repaintBase64 !== "string" ||
    receipt.repaintBase64.length === 0
  ) {
    throw new ProviderUnavailableError(provider, "no canonical ANSI screen");
  }
  const decoded = Buffer.from(receipt.repaintBase64, "base64").toString("utf8");
  const publicWorktreeAlias = workingDirectory
    ? `~/dure-demo/${provider}`
    : "~/dure-demo";
  const normalized = normalizeProviderScreen(decoded, {
    home,
    abbreviatedPathAlias: publicWorktreeAlias,
    ownedPaths: [
      workingDirectory
        ? { path: workingDirectory, alias: publicWorktreeAlias }
        : null,
      { path: fixture?.repo, alias: "~/dure-demo" },
      { path: fixture?.root, alias: "~/dure-demo" },
      { path: repoRoot, alias: "~/dure-demo" },
    ].filter((entry) => entry?.path),
  });
  assertProviderScreenSafe(provider, normalized);
  return {
    atMs: 0,
    columns: receipt.columns,
    rows: receipt.rows,
    sequenceThrough: String(receipt.sequenceThrough),
    repaintBase64: Buffer.from(normalized, "utf8").toString("base64"),
  };
}

async function listSessions(state) {
  await assertOwnedProviderFixture(state.fixture, state.ledgerPath);
  const receipt = await state.run(
    state.hmux,
    hmuxArgs(state.fixture.discoveryRoot, "ls", ["--class", "standalone"]),
    { env: state.env, timeoutMs: 10_000 },
  );
  const sessions = parseJson(receipt.stdout, "hmux ls");
  if (!Array.isArray(sessions)) throw new Error("hmux ls JSON must be an array");
  return sessions;
}

async function waitForExactRecord(state, sessionId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const record = (await listSessions(state)).find(
      (candidate) => candidate.session_id === sessionId,
    );
    if (
      record?.host_process?.process_id &&
      record.host_process.start_marker &&
      record?.provider_process?.process_id &&
      record.provider_process.start_marker
    ) {
      return record;
    }
    await state.sleep(100);
  }
  throw new Error(`hmux did not publish an exact process receipt for ${sessionId}`);
}

async function readScreenReceipt(state, sessionId) {
  const receipt = await state.run(
    state.hmux,
    hmuxArgs(state.fixture.discoveryRoot, "screen", [
      sessionId,
      "--format",
      "json",
    ]),
    { env: state.env, timeoutMs: 5_000 },
  );
  return parseJson(receipt.stdout, "hmux screen");
}

async function readScreen(state, provider, sessionId) {
  const workingDirectory = state.sessions.find(
    (session) => session.sessionId === sessionId,
  )?.workingDirectory;
  return decodeHmuxScreen(
    provider,
    await readScreenReceipt(state, sessionId),
    state.env.HOME,
    state.fixture,
    workingDirectory,
  );
}

async function waitForTerminalSize(state, provider, sessionId) {
  let observedGeometry = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const receipt = await readScreenReceipt(state, sessionId);
    observedGeometry = {
      columns: receipt.columns,
      rows: receipt.rows,
    };
    if (
      receipt.columns === state.terminalSize.columns &&
      receipt.rows === state.terminalSize.rows
    ) {
      return;
    }
    await state.sleep(100);
  }
  throw new ProviderUnavailableError(
    provider,
    `Hmux did not apply ${state.terminalSize.columns}x${state.terminalSize.rows} capture geometry (observed ${observedGeometry?.columns ?? "unknown"}x${observedGeometry?.rows ?? "unknown"})`,
  );
}

async function waitForInitialScreen(state, provider, sessionId) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await readScreen(state, provider, sessionId);
    } catch (error) {
      if (
        error instanceof UnsafeProviderOutputError ||
        error instanceof ProviderAuthenticationRequiredError
      ) {
        throw error;
      }
      lastError = error;
      await state.sleep(250);
    }
  }
  throw new ProviderUnavailableError(
    provider,
    lastError instanceof Error ? lastError.message : "startup timed out",
  );
}

async function writePrompt(state, sessionId, prompt) {
  await state.run(
    state.hmux,
    hmuxArgs(state.fixture.discoveryRoot, "send-keys", [
      "--target",
      sessionId,
      "--literal",
      prompt,
    ]),
    { env: state.env, timeoutMs: 5_000 },
  );
  await state.sleep(250);
  await state.run(
    state.hmux,
    hmuxArgs(state.fixture.discoveryRoot, "send-keys", [
      "--target",
      sessionId,
      "Enter",
    ]),
    { env: state.env, timeoutMs: 5_000 },
  );
}

async function writeLiteralInput(state, sessionId, input) {
  await state.run(
    state.hmux,
    hmuxArgs(state.fixture.discoveryRoot, "send-keys", [
      "--target",
      sessionId,
      "--literal",
      input,
    ]),
    { env: state.env, timeoutMs: 5_000 },
  );
}

function frameText(frame) {
  return Buffer.from(frame.repaintBase64, "base64").toString("utf8");
}

function readableFrameText(frame) {
  return visibleProviderText(frameText(frame));
}

function isProviderBoundaryError(error) {
  return (
    error instanceof UnsafeProviderOutputError ||
    error instanceof ProviderAuthenticationRequiredError
  );
}

function providerContextError(error, label, frame) {
  const message = error instanceof Error ? error.message : String(error);
  const excerpt = frame ? readableFrameText(frame).slice(0, 512) : null;
  return new Error(`${message}; ${label} ${JSON.stringify(excerpt)}`, {
    cause: error,
  });
}

async function withProviderScreenContext(
  state,
  provider,
  sessionId,
  label,
  operation,
  fallbackFrame = null,
) {
  try {
    return await operation();
  } catch (error) {
    if (isProviderBoundaryError(error)) throw error;
    let frame = fallbackFrame;
    if (!frame) {
      try {
        frame = await readScreen(state, provider, sessionId);
      } catch (screenError) {
        if (isProviderBoundaryError(screenError)) throw screenError;
      }
    }
    throw providerContextError(error, label, frame);
  }
}

export function videoInitialFrame(frames) {
  return frames[1] ?? frames[0];
}

function targetOpensAsFloatingPane(scenario, target) {
  return [...scenario.setup, ...scenario.timeline].some(
    (step) =>
      step.action === "floatAgent" && step.agentId === target.agentId,
  );
}

function clearScrollbackBeforeFrame(frame) {
  const repaint = Buffer.from(frame.repaintBase64, "base64").toString("utf8");
  if (repaint.startsWith("\u001b[3J")) return frame;
  return {
    ...frame,
    repaintBase64: Buffer.from(`\u001b[3J${repaint}`, "utf8").toString(
      "base64",
    ),
  };
}

export function stillFrameForTarget(scenario, target, frames) {
  const opensAsFloatingPane = targetOpensAsFloatingPane(scenario, target);
  // A provider can satisfy the substantive-response threshold while its TUI is
  // still rewriting the active response. That is useful motion for the video,
  // but the last canonical screen can be an unattractive transitional repaint.
  // Floating panes are especially exposed because their narrower viewport
  // turns that repaint into fragmented lines. The prompt-confirmed frame is the
  // same clean interaction boundary used to seed the video and remains live
  // provider output rather than a fixture.
  return opensAsFloatingPane
    ? clearScrollbackBeforeFrame(videoInitialFrame(frames))
    : frames.at(-1);
}

async function sendNamedKeys(state, sessionId, keys) {
  for (const key of keys) {
    await state.run(
      state.hmux,
      hmuxArgs(state.fixture.discoveryRoot, "send-keys", [
        "--target",
        sessionId,
        key,
      ]),
      { env: state.env, timeoutMs: 5_000 },
    );
    await state.sleep(200);
  }
}

async function resolveStartupPrompts(state, provider, sessionId) {
  let frame = await waitForInitialScreen(state, provider, sessionId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const screen = readableFrameText(frame);
    const keys = providerStartupKeys(provider, screen);
    if (keys) {
      await sendNamedKeys(state, sessionId, keys);
      await state.sleep(800);
    } else if (providerScreenReady(provider, screen)) {
      // Give the interactive input widget one final quiet period. Startup
      // prompts can briefly disappear while the provider swaps screens.
      await state.sleep(800);
      const settled = await readScreen(state, provider, sessionId);
      if (providerScreenReady(provider, readableFrameText(settled))) {
        await state.sleep(provider === "claude" ? 1_800 : 600);
        const ready = await readScreen(state, provider, sessionId);
        if (providerScreenReady(provider, readableFrameText(ready))) return ready;
      }
    }
    await state.sleep(250);
    frame = await withProviderScreenContext(
      state,
      provider,
      sessionId,
      "last provider startup screen",
      () => readScreen(state, provider, sessionId),
      frame,
    );
  }
  throw new ProviderUnavailableError(provider, "interactive screen did not become ready");
}

function promptIsVisible(provider, screen, prompt) {
  if (screen.includes(prompt.slice(0, 32))) return true;
  if (provider === "codex") {
    return /\b(?:Working|Explored|Ran|Edited)\b/u.test(screen);
  }
  if (provider === "claude") {
    return /(?:thinking|esc to interrupt|⏺)/u.test(screen);
  }
  if (provider === "kimi") {
    return /(?:thinking|Working|Kimi\s*>)/iu.test(screen);
  }
  return false;
}

async function sendPromptAndConfirm(state, provider, sessionId, prompt) {
  for (let sendAttempt = 0; sendAttempt < 2; sendAttempt += 1) {
    await writePrompt(state, sessionId, prompt);
    for (let readAttempt = 0; readAttempt < 16; readAttempt += 1) {
      await state.sleep(250);
      const frame = await readScreen(state, provider, sessionId);
      const screen = readableFrameText(frame);
      const startupKeys = providerStartupKeys(provider, screen);
      if (startupKeys) {
        await sendNamedKeys(state, sessionId, startupKeys);
        await state.sleep(800);
        continue;
      }
      if (
        providerScreenReady(provider, screen) &&
        promptIsVisible(provider, screen, prompt)
      ) {
        return frame;
      }
    }
  }
  throw new ProviderUnavailableError(provider, "interactive prompt was not accepted");
}

function appendDistinctFrame(frames, frame, startedAt, now) {
  const previous = frames.at(-1);
  if (
    previous?.sequenceThrough === frame.sequenceThrough &&
    previous?.repaintBase64 === frame.repaintBase64
  ) {
    return;
  }
  frames.push({ ...frame, atMs: Math.max(0, now() - startedAt) });
}

async function captureProvider(
  state,
  provider,
  { dedicatedSessionId, excludedSessionIds = new Set() } = {},
) {
  const spec = providerSpec(provider, state.env);
  if (spec && state.scenario.fixture.productTour) spec.prompt = "Inspect the session handoff and run npm test. Reply in English.";
  state.terminalSize = dedicatedSessionId
    ? terminalCaptureSize(
        state.scenario,
        provider,
        dedicatedSessionId,
        state.terminalSizesBySession,
      )
    : primaryTerminalSize(
        state.scenario,
        provider,
        state.terminalSizesBySession,
      );
  const executable = spec
    ? await executablePath(spec.executable, state.env)
    : null;
  if (!spec || !executable) {
    throw new ProviderUnavailableError(provider, "CLI executable was not found");
  }
  if (state.closing) {
    throw new ProviderUnavailableError(provider, "capture is closing");
  }
  const sessionName = `dure-media-${provider}${
    dedicatedSessionId ? `-${dedicatedSessionId}` : ""
  }`;
  const intent = {
    intentId: randomUUID(),
    provider,
    sessionName,
    state: "pending",
  };
  const spawnOperation = (async () => {
    state.spawnIntents.push(intent);
    await writeCleanupLedger(
      state.fixture,
      state.sessions,
      state.spawnIntents,
    );
    if (state.closing) {
      intent.state = "cancelled";
      await writeCleanupLedger(
        state.fixture,
        state.sessions,
        state.spawnIntents,
      );
      throw new ProviderUnavailableError(provider, "capture is closing");
    }
    const workingDirectory = await createProviderDemoWorktree(
      state.fixture,
      sessionName,
      state.env,
    );
    const automationState = await prepareProviderAutomationState({
      env: state.env,
      fixture: state.fixture,
      provider,
      sessionName,
      workingDirectory,
    });
    const providerCommand = providerAutomationCommand(
      executable,
      spec.args,
      automationState,
    );
    const creation = await state.run(
      state.hmux,
      hmuxArgs(state.fixture.discoveryRoot, "new", [
        "--name",
        sessionName,
        "--env",
        "TERM=xterm-256color",
        ...providerCommand,
      ]),
      {
        cwd: workingDirectory,
        env: state.env,
        timeoutMs: 20_000,
      },
    );
    const created = parseJson(creation.stdout, "hmux new");
    if (created?.ok !== true || typeof created.sessionId !== "string") {
      throw new ProviderUnavailableError(
        provider,
        "hmux did not create a session",
      );
    }
    const session = {
      provider,
      sessionId: created.sessionId,
      record: null,
      workingDirectory,
    };
    state.sessions.push(session);
    intent.state = "resolved";
    intent.sessionId = session.sessionId;
    await writeCleanupLedger(
      state.fixture,
      state.sessions,
      state.spawnIntents,
    );
    return session;
  })();
  state.spawnInFlight = spawnOperation;
  let session;
  try {
    session = await spawnOperation;
  } finally {
    if (state.spawnInFlight === spawnOperation) state.spawnInFlight = null;
  }
  if (state.closing) {
    throw new ProviderUnavailableError(provider, "capture is closing");
  }
  const record = await waitForExactRecord(state, session.sessionId);
  session.record = record;
  await writeCleanupLedger(
    state.fixture,
    state.sessions,
    state.spawnIntents,
  );
  await withProviderScreenContext(
    state,
    provider,
    session.sessionId,
    "provider startup screen",
    async () => {
      await resizeHmuxSession(state, session.sessionId);
      await waitForTerminalSize(state, provider, session.sessionId);
    },
  );

  const frames = [];
  const startedAt = state.now();
  let readyFrame = await resolveStartupPrompts(
    state,
    provider,
    session.sessionId,
  );
  if (provider === "codex") {
    // Codex keeps the accepted workspace-trust dialog in inline scrollback.
    // Clear it through the real TUI gesture before collecting public media.
    await writeLiteralInput(state, session.sessionId, "\u000c");
    await state.sleep(600);
    const clearedFrame = await withProviderScreenContext(
      state,
      provider,
      session.sessionId,
      "provider ready screen",
      () => readScreen(state, provider, session.sessionId),
      readyFrame,
    );
    if (providerScreenReady(provider, readableFrameText(clearedFrame))) {
      readyFrame = clearedFrame;
    }
  }
  appendDistinctFrame(
    frames,
    readyFrame,
    startedAt,
    state.now,
  );
  const baselineScreen = readableFrameText(readyFrame);
  appendDistinctFrame(
    frames,
    await sendPromptAndConfirm(
      state,
      provider,
      session.sessionId,
      spec.prompt,
    ),
    startedAt,
    state.now,
  );
  const deadline = state.now() + sampleDurationMs(state.env);
  let completed = false;
  let observedTestRun = false;
  while (state.now() < deadline) {
    try {
      if (state.closing) break;
      const frame = await readScreen(state, provider, session.sessionId);
      const screen = readableFrameText(frame);
      const startupKeys = providerStartupKeys(provider, screen);
      if (startupKeys) {
        await sendNamedKeys(state, session.sessionId, startupKeys);
        await state.sleep(800);
        continue;
      }
      if (!providerScreenReady(provider, screen)) {
        await state.sleep(SAMPLE_INTERVAL_MS);
        continue;
      }
      appendDistinctFrame(
        frames,
        frame,
        startedAt,
        state.now,
      );
      observedTestRun ||= /\bRan\b[\s\S]{0,800}\b(?:npm test|node --test)\b/iu.test(screen);
      if (
        (!state.scenario.fixture.productTour || observedTestRun) &&
        providerResponseComplete(provider, screen, {
          baseline: baselineScreen,
          prompt: spec.prompt,
        })
      ) {
        completed = true;
        break;
      }
    } catch (error) {
      if (
        error instanceof UnsafeProviderOutputError ||
        error instanceof ProviderAuthenticationRequiredError
      ) {
        throw error;
      }
      // A provider may be redrawing or exiting between two canonical reads.
    }
    await state.sleep(SAMPLE_INTERVAL_MS);
  }
  if (!completed) {
    throw new ProviderUnavailableError(
      provider,
      "did not return a substantive response before the capture deadline",
    );
  }
  if (dedicatedSessionId) {
    return {
      frames,
      framesBySession: { [dedicatedSessionId]: frames },
    };
  }
  return capturePaneSizedFrames({
    excludedSessionIds,
    frames,
    liveSessionId: session.sessionId,
    measuredSizes: state.terminalSizesBySession,
    provider,
    readFrame: (sessionId) => readScreen(state, provider, sessionId),
    resize: async (sessionId, size) => {
      state.terminalSize = size;
      await resizeHmuxSession(state, sessionId);
      await waitForTerminalSize(state, provider, sessionId);
    },
    scenario: state.scenario,
    sleep: state.sleep,
    visibleText: readableFrameText,
    ready: (screen) => providerScreenReady(provider, screen),
  });
}

async function processAbsent(state, process) {
  const receipt = await state.run(
    state.hmux,
    hmuxArgs(state.fixture.discoveryRoot, "process", [
      "probe",
      String(process.process_id),
      String(process.start_marker),
    ]),
    { env: state.env, timeoutMs: 5_000 },
  );
  return processProbeIsAbsent(
    process,
    parseJson(receipt.stdout, "hmux process probe"),
  );
}

async function observeLiveSessionContinuity(state, sessions) {
  return Promise.all(
    sessions.map(async (session) => {
      const record = await waitForExactRecord(state, session.sessionId);
      if (record.workingDirectory?.path !== session.workingDirectory) {
        throw new Error(
          `live ${session.provider} session did not project its exact working directory`,
        );
      }
      const screen = await readScreen(
        state,
        session.provider,
        session.sessionId,
      );
      const [hostAbsent, providerAbsent] = await Promise.all([
        processAbsent(state, record.host_process),
        processAbsent(state, record.provider_process),
      ]);
      return {
        provider: session.provider,
        sessionId: session.sessionId,
        workingDirectory: record.workingDirectory?.path,
        fence: fenceFromSessionRecord(record),
        hostProcess: record.host_process,
        providerProcess: record.provider_process,
        hostLive: !hostAbsent,
        providerLive: !providerAbsent,
        sequenceThrough: screen.sequenceThrough,
      };
    }),
  );
}

export function assertLiveSessionContinuity(before, after) {
  const sort = (observations) =>
    [...observations].sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
  const beforeSorted = sort(before);
  const afterSorted = sort(after);
  if (beforeSorted.length === 0 || beforeSorted.length !== afterSorted.length) {
    throw new Error("live Hmux continuity observations have different sessions");
  }
  for (const [index, previous] of beforeSorted.entries()) {
    const current = afterSorted[index];
    if (
      previous.sessionId !== current.sessionId ||
      previous.provider !== current.provider
    ) {
      throw new Error("live Hmux session identity changed across reconnect");
    }
    if (
      !isAbsolute(previous.workingDirectory ?? "") ||
      previous.workingDirectory !== current.workingDirectory
    ) {
      throw new Error("live Hmux working directory changed across reconnect");
    }
    if (!isDeepStrictEqual(previous.fence, current.fence)) {
      throw new Error("live Hmux generation fence changed across reconnect");
    }
    if (
      !isDeepStrictEqual(previous.hostProcess, current.hostProcess) ||
      !isDeepStrictEqual(previous.providerProcess, current.providerProcess)
    ) {
      throw new Error("live Hmux process generation changed across reconnect");
    }
    if (
      !previous.hostLive ||
      !previous.providerLive ||
      !current.hostLive ||
      !current.providerLive
    ) {
      throw new Error("live Hmux process exited across reconnect");
    }
    if (BigInt(current.sequenceThrough) < BigInt(previous.sequenceThrough)) {
      throw new Error("live Hmux screen sequence moved backwards across reconnect");
    }
  }
  const workingDirectories = beforeSorted.map(
    ({ workingDirectory }) => workingDirectory,
  );
  if (new Set(workingDirectories).size !== workingDirectories.length) {
    throw new Error("live Hmux sessions share one working directory");
  }
  return {
    liveSessionCount: beforeSorted.length,
    providers: [...new Set(beforeSorted.map(({ provider }) => provider))],
    exactSessionFencesPreserved: true,
    processGenerationsLive: true,
    sequencesNondecreasing: true,
    distinctWorkingDirectories: true,
  };
}

export function processProbeIsAbsent(expected, receipt) {
  if (
    receipt?.schemaVersion !== 1 ||
    !["live", "absent"].includes(receipt?.status) ||
    String(receipt?.process?.process_id) !== String(expected?.process_id) ||
    receipt?.process?.start_marker !== expected?.start_marker
  ) {
    throw new Error("hmux process probe did not echo the exact process generation");
  }
  return receipt.status === "absent";
}

async function waitForProcessAbsent(state, process) {
  if (!process?.process_id || !process?.start_marker) {
    throw new Error("hmux cleanup is missing an exact process-generation proof");
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await processAbsent(state, process)) return true;
    await state.sleep(100);
  }
  return false;
}

async function cleanupSession(state, session) {
  const current = (await listSessions(state)).find(
    (candidate) => candidate.session_id === session.sessionId,
  );
  const record = current
    ? {
        ...session.record,
        ...current,
        host_process: current.host_process ?? session.record?.host_process,
        provider_process:
          current.provider_process ?? session.record?.provider_process,
      }
    : session.record;
  const fence = fenceFromSessionRecord(record);
  try {
    await state.run(
      state.hmux,
      hmuxArgs(state.fixture.discoveryRoot, "kill", [
        session.sessionId,
        "--expected-fence-json",
        JSON.stringify(fence),
        "--timeout-ms",
        "5000",
      ]),
      { env: state.env, timeoutMs: 10_000 },
    );
  } catch {
    // An already-exited provider can race the exact kill. Process-generation
    // probes below remain the authority for whether cleanup is safe.
  }
  const [hostAbsent, providerAbsent] = await Promise.all([
    waitForProcessAbsent(state, record.host_process),
    waitForProcessAbsent(state, record.provider_process),
  ]);
  if (!hostAbsent || !providerAbsent) {
    throw new Error(`exact hmux process generation is still live for ${session.provider}`);
  }
}

async function cleanupState(state) {
  const errors = [];
  try {
    await retireProviderAutomationCredentials(
      state.fixture,
      state.spawnIntents ?? [],
    );
  } catch (error) {
    errors.push(error);
  }
  const trackedIds = new Set(state.sessions.map(({ sessionId }) => sessionId));
  const pendingIntents = (state.spawnIntents ?? []).filter(
    ({ state: intentState }) => intentState === "pending",
  );
  const pendingSessionNames = new Set(
    pendingIntents
      .map(({ sessionName }) => sessionName)
      .filter((sessionName) => typeof sessionName === "string"),
  );
  const legacyPendingProviders = new Set(
    pendingIntents
      .filter(({ sessionName }) => typeof sessionName !== "string")
      .map(({ provider }) => provider),
  );
  const observedPendingSessionNames = new Set();
  const observedLegacyPendingProviders = new Set(
    state.sessions
      .map(({ provider }) => provider)
      .filter((provider) => legacyPendingProviders.has(provider)),
  );
  const providerFromRecord = (record) =>
    record.session_name?.match(/^dure-media-([a-z0-9]+)/u)?.[1] ??
    "unidentified-provider";
  const discoverNewSessions = async () => {
    let discovered = 0;
    for (const record of await listSessions(state)) {
      const provider = providerFromRecord(record);
      if (pendingSessionNames.has(record.session_name)) {
        observedPendingSessionNames.add(record.session_name);
      }
      if (legacyPendingProviders.has(provider)) {
        observedLegacyPendingProviders.add(provider);
      }
      if (trackedIds.has(record.session_id)) continue;
      trackedIds.add(record.session_id);
      state.sessions.push({ provider, sessionId: record.session_id, record });
      discovered += 1;
    }
    return discovered;
  };
  try {
    await discoverNewSessions();
  } catch (error) {
    errors.push(error);
  }
  const cleanedIds = new Set();
  const cleanupDiscoveredSessions = async () => {
    for (const session of [...state.sessions].reverse()) {
      if (cleanedIds.has(session.sessionId)) continue;
      cleanedIds.add(session.sessionId);
      try {
        await cleanupSession(state, session);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await cleanupDiscoveredSessions();
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      if ((await discoverNewSessions()) === 0) break;
      await cleanupDiscoveredSessions();
    } catch (error) {
      errors.push(error);
      break;
    }
  }
  for (const sessionName of pendingSessionNames) {
    if (!observedPendingSessionNames.has(sessionName)) {
      errors.push(
        new Error(
          `unresolved ${sessionName} spawn intent forbids fixture-root removal`,
        ),
      );
    }
  }
  for (const provider of legacyPendingProviders) {
    if (!observedLegacyPendingProviders.has(provider)) {
      errors.push(
        new Error(
          `unresolved ${provider} spawn intent forbids fixture-root removal`,
        ),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `live provider fixture retained at ${state.fixture.root}`,
    );
  }
  await assertOwnedProviderFixture(state.fixture, state.ledgerPath);
  const relativeRoot = relative(providerFixtureRoot, state.fixture.root);
  if (
    relativeRoot === "" ||
    relativeRoot.startsWith("..") ||
    resolve(providerFixtureRoot, relativeRoot) !== resolve(state.fixture.root)
  ) {
    throw new Error("refusing to remove provider fixture outside its owned root");
  }
  await rm(state.fixture.root, { recursive: true, force: true });
}

async function closeState(state) {
  state.closing = true;
  if (!state.cleanupPromise) {
    state.cleanupPromise = (async () => {
      await state.spawnInFlight?.catch(() => {});
      await cleanupState(state);
      await removeCleanupLedger(state.ledgerPath);
      state.removeSignalHandlers?.();
    })();
  }
  return state.cleanupPromise;
}

function installSignalCleanup(state) {
  const handlers = new Map();
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      closeState(state)
        .catch((error) => {
          process.stderr.write(`[media-capture] ${error.stack ?? error}\n`);
        })
        .finally(() => process.exit(exitCode));
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  state.removeSignalHandlers = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

async function recoverInterruptedRuns(hmux, env, run, sleepFn) {
  const { ledgers, errors } = await recoverableCleanupLedgers();
  for (const ledger of ledgers) {
    try {
      const claimed = await claimCleanupLedger(ledger);
      if (!claimed) continue;
      const state = {
        closing: true,
        env: { ...env, HMUX_DISCOVERY_ROOT: claimed.fixture.discoveryRoot },
        fixture: claimed.fixture,
        hmux,
        ledgerPath: claimed.path,
        run,
        sessions: claimed.sessions,
        sleep: sleepFn,
        spawnIntents: claimed.spawnIntents,
      };
      await cleanupState(state);
      await removeCleanupLedger(claimed.path);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "interrupted provider cleanup is incomplete");
  }
}

function scenarioWithFrames(scenario, providerFrames, frameSelector) {
  const copy = structuredClone(scenario);
  copy.liveProviderSessionIds = [];
  for (const [provider, providerCapture] of providerFrames) {
    for (const target of sessionTargetsForProvider(copy, provider)) {
      const frames = framesForSessionTarget(providerCapture, target.id);
      const selected = frameSelector(frames, { scenario: copy, target });
      const screen = Buffer.from(selected.repaintBase64, "base64").toString("utf8");
      copy.fixture.terminalSnapshots[target.id] = screen;
      copy.fixture.terminalSnapshotGeometry ??= {};
      copy.fixture.terminalSnapshotGeometry[target.id] = {
        columns: selected.columns,
        rows: selected.rows,
      };
      copy.liveProviderSessionIds.push(target.id);
    }
  }
  return copy;
}

export function replayFramesBySession(scenario, providerFrames) {
  const replay = {};
  const openedAgentIds = new Set(
    [...scenario.setup, ...scenario.timeline]
      .filter(({ action }) => action === "openAgent")
      .map(({ agentId }) => agentId),
  );
  for (const [provider, providerCapture] of providerFrames) {
    for (const target of sessionTargetsForProvider(scenario, provider)) {
      const headlessTarget = scenario.fixture.headlessSpawn?.providerTarget;
      const opensFromHeadlessSpawn = headlessTarget?.sessionId === target.id;
      if (!openedAgentIds.has(target.agentId) && !opensFromHeadlessSpawn && !scenario.fixture.productTour?.providerTargets.some(({ id }) => id === target.id)) continue;
      const frames = framesForSessionTarget(providerCapture, target.id);
      const opensAsFloatingPane = targetOpensAsFloatingPane(scenario, target);
      const visibility = opensAsFloatingPane
        ? floatingReplayVisibility(scenario, target)
        : replayVisibility(scenario, target.id);
      replay[target.id] = {
        kind: target.kind,
        frames: opensAsFloatingPane
          ? [clearScrollbackBeforeFrame(videoInitialFrame(frames))]
          : frames,
        ...visibility,
      };
    }
  }
  return replay;
}

export async function createLiveProviderMedia(options) {
  const requiresLiveContinuity = captureProofNeedsLiveContinuity(
    options.scenario,
  );
  const env = { ...process.env, ...options.env };
  const hmuxCommand = env.DURE_MEDIA_HMUX_BIN || "hmux";
  const hmux = await executablePath(hmuxCommand, env);
  if (!hmux) {
    if (
      options.requireLiveProviders || requiresLiveContinuity
    ) {
      throw new ProviderUnavailableError("hmux", "CLI executable was not found");
    }
    return {
      stillScenario: structuredClone(options.scenario),
      videoScenario: structuredClone(options.scenario),
      replayBySession: {},
      providers: [],
      fallbackProviders: providersForScenario(options.scenario),
      fallbackReasons: Object.fromEntries(
        providersForScenario(options.scenario).map((provider) => [
          provider,
          "hmux-unavailable",
        ]),
      ),
      continuityEvidence: [],
      async probeLiveSessions() {},
      async close() {},
    };
  }
  const run = options.run ?? defaultRun;
  try {
    await preflightHmux(hmux, env, run);
  } catch (error) {
    if (
      options.requireLiveProviders || requiresLiveContinuity
    ) {
      throw error;
    }
    const providers = providersForScenario(options.scenario);
    return {
      stillScenario: structuredClone(options.scenario),
      videoScenario: structuredClone(options.scenario),
      replayBySession: {},
      providers: [],
      fallbackProviders: providers,
      fallbackReasons: Object.fromEntries(
        providers.map((provider) => [provider, "hmux-incompatible"]),
      ),
      continuityEvidence: [],
      async probeLiveSessions() {},
      async close() {},
    };
  }
  await recoverInterruptedRuns(hmux, env, run, options.sleep ?? sleep);
  const fixture = await createProviderDemoRepo(options.scenario.id, env);
  const state = {
    env: { ...env, HMUX_DISCOVERY_ROOT: fixture.discoveryRoot },
    fixture,
    hmux,
    now: options.now ?? Date.now,
    run,
    sessions: [],
    spawnIntents: [],
    sleep: options.sleep ?? sleep,
    scenario: options.scenario,
    terminalSize: terminalCaptureSize(options.scenario),
    terminalSizesBySession: options.terminalSizesBySession,
  };
  state.ledgerPath = await writeCleanupLedger(
    fixture,
    state.sessions,
    state.spawnIntents,
  );
  installSignalCleanup(state);
  const providerFrames = new Map();
  const fallbackReasons = Object.fromEntries(
    providersForScenario(options.scenario)
      .filter((provider) => providerSpec(provider, state.env) === null)
      .map((provider) => [provider, "unsupported-live-provider"]),
  );
  try {
    for (const provider of liveProvidersForScenario(options.scenario)) {
      if (state.closing) break;
      options.progress?.(`starting isolated live ${provider} session`);
      try {
        const dedicatedTargets = dedicatedTargetsForProvider(
          options.scenario,
          provider,
        );
        const providerCapture = await captureProvider(state, provider, {
          excludedSessionIds: new Set(
            dedicatedTargets.map(({ id }) => id),
          ),
        });
        for (const target of dedicatedTargets) {
          options.progress?.(
            `starting pane-sized live ${provider} session for ${target.id}`,
          );
          const dedicated = await captureProvider(state, provider, {
            dedicatedSessionId: target.id,
          });
          providerCapture.framesBySession[target.id] = dedicated.frames;
        }
        providerFrames.set(provider, providerCapture);
      } catch (error) {
        if (error instanceof UnsafeProviderOutputError) throw error;
        if (
          state.spawnIntents.some(
            ({ state: intentState }) => intentState === "pending",
          )
        ) {
          throw error;
        }
        if (options.requireLiveProviders) throw error;
        fallbackReasons[provider] =
          error instanceof ProviderAuthenticationRequiredError
            ? "authentication-required"
            : "live-provider-unavailable";
        options.progress?.(
          `using tracked ${provider} fallback (${fallbackReasons[provider]}: ${error.message})`,
        );
      }
    }
  } catch (error) {
    await closeState(state).catch((cleanupError) => {
      throw new AggregateError([error, cleanupError], "live provider setup failed");
    });
    throw error;
  }
  const missingContinuityProviders = providersForScenario(
    options.scenario,
  ).filter((provider) => !providerFrames.has(provider));
  if (
    requiresLiveContinuity && missingContinuityProviders.length > 0
  ) {
    const error = new ProviderUnavailableError(
      "hmux-client-continuity",
      `live provider proof is missing for ${missingContinuityProviders.join(", ")}`,
    );
    await closeState(state).catch((cleanupError) => {
      throw new AggregateError(
        [error, cleanupError],
        "live continuity setup failed",
      );
    });
    throw error;
  }
  const continuityBaselines = new Map();
  const continuityEvidence = [];
  const continuitySessions = () =>
    state.sessions.filter(({ provider }) => providerFrames.has(provider));
  const probeLiveSessions = async ({ captureKind, phase }) => {
    if (!requiresLiveContinuity) return undefined;
    const observations = await observeLiveSessionContinuity(
      state,
      continuitySessions(),
    );
    if (phase === "before") {
      if (continuityBaselines.has(captureKind)) {
        throw new Error(`duplicate ${captureKind} continuity baseline`);
      }
      continuityBaselines.set(captureKind, observations);
      return undefined;
    }
    if (phase !== "after" || !continuityBaselines.has(captureKind)) {
      throw new Error(`missing ${captureKind} continuity baseline`);
    }
    const evidence = {
      captureKind,
      ...assertLiveSessionContinuity(
        continuityBaselines.get(captureKind),
        observations,
      ),
    };
    continuityBaselines.delete(captureKind);
    continuityEvidence.push(evidence);
    return evidence;
  };
  return {
    stillScenario: scenarioWithFrames(
      options.scenario,
      providerFrames,
      (frames, { scenario, target }) =>
        stillFrameForTarget(scenario, target, frames),
    ),
    videoScenario: scenarioWithFrames(
      options.scenario,
      providerFrames,
      (frames, { scenario, target }) =>
        targetOpensAsFloatingPane(scenario, target)
          ? clearScrollbackBeforeFrame(videoInitialFrame(frames))
          : videoInitialFrame(frames),
    ),
    replayBySession: replayFramesBySession(options.scenario, providerFrames),
    providers: [...providerFrames.keys()],
    fallbackProviders: providersForScenario(options.scenario).filter(
      (provider) => !providerFrames.has(provider),
    ),
    fallbackReasons,
    continuityEvidence,
    probeLiveSessions,
    close: async () => closeState(state),
  };
}

export function fixtureProviderMedia(scenario) {
  const providers = providersForScenario(scenario);
  return {
    stillScenario: structuredClone(scenario),
    videoScenario: structuredClone(scenario),
    replayBySession: {},
    providers: [],
    fallbackProviders: providers,
    fallbackReasons: Object.fromEntries(
      providers.map((provider) => [provider, "explicit-fixture-source"]),
    ),
    continuityEvidence: [],
    async probeLiveSessions() {},
    async close() {},
  };
}
