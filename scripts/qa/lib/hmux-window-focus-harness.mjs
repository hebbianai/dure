import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  qaHttpRouteLabel,
  resolveQaHttpTimeout,
  withHttpTimeout,
} from "./http-client.mjs";
import { QaExecutionTimeline } from "./qa-execution.mjs";

const DESCRIPTOR_TIMEOUT_MS = 180_000;
const WINDOW_TIMEOUT_MS = Number(
  process.env.HMUX_WINDOW_FOCUS_WINDOW_TIMEOUT_MS ?? 30_000,
);
const RUNTIME_PREPARE_HTTP_TIMEOUT_MS = resolveQaHttpTimeout(
  process.env.HMUX_WINDOW_FOCUS_RUNTIME_PREPARE_TIMEOUT_MS ?? 35_000,
);
const FRONTEND_PREPARE_HTTP_TIMEOUT_MS = resolveQaHttpTimeout(
  process.env.HMUX_WINDOW_FOCUS_FRONTEND_PREPARE_TIMEOUT_MS ?? 35_000,
);
const POLL_INTERVAL_MS = 100;
const EVIDENCE_STATUS_INTERVAL_MS = 1_000;
const HTTP_TIMEOUT_MS = resolveQaHttpTimeout(
  process.env.HEBBIAN_QA_HTTP_TIMEOUT_MS,
);

export const WINDOW_ROLES = ["a", "b"];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HmuxWindowFocusHarness {
  constructor() {
    this.descriptorPath =
      process.env.DURE_QA_SERVER_DESCRIPTOR ??
      path.join(process.env.HOME ?? "", ".hebbian", "server.json");
    this.descriptor = undefined;
    this.proof = undefined;
    this.lastWindowStatus = undefined;
    this.lastControllerPageStatus = undefined;
    this.frontendAssetPreparation = undefined;
    this.latestMarkerPipeline = undefined;
    this.runtimePreparation = undefined;
    this.evidenceDir = process.env.HEBBIAN_QA_EVIDENCE_DIR;
    this.evidenceWriteWarningShown = false;
    this.nextEvidenceStatusWriteAt = 0;
    this.execution = new QaExecutionTimeline(
      process.env.HEBBIAN_QA_LAYER ?? "exclusive_focus",
    );
  }

  async phase(phase, failureClass, operation) {
    this.execution.begin(phase);
    this.recordExecutionEvidence();
    try {
      const result = await operation();
      this.execution.complete();
      this.recordExecutionEvidence();
      return result;
    } catch (error) {
      this.execution.fail(failureClass);
      this.recordExecutionEvidence();
      throw error;
    }
  }

  async connect() {
    this.descriptor = await this.waitFor(
      "debug app server descriptor",
      DESCRIPTOR_TIMEOUT_MS,
      async () => {
        if (!fs.existsSync(this.descriptorPath)) return undefined;
        const candidate = JSON.parse(
          fs.readFileSync(this.descriptorPath, "utf8"),
        );
        if (
          !Number.isInteger(candidate.port) ||
          typeof candidate.token !== "string"
        ) {
          throw new Error("invalid HebbianIDE server descriptor");
        }
        const response = await withHttpTimeout(
          "GET /ping",
          (signal) =>
            fetch(`http://127.0.0.1:${candidate.port}/ping`, {
              headers: { Authorization: `Bearer ${candidate.token}` },
              signal,
            }),
          HTTP_TIMEOUT_MS,
        );
        return response.ok ? candidate : undefined;
      },
    );
    return this.waitControllerFixtureReady();
  }

  async waitControllerFixtureReady() {
    const candidate = await this.waitFor(
      "the QA controller native page to load",
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.request(
          "GET",
          "/qa/hmux/window-focus/controller-ready",
        );
        this.lastControllerPageStatus = candidate;
        this.recordControllerPageEvidence();
        return candidate.page?.nativeFinishedCount > 0 &&
          typeof candidate.page.nativeUrl === "string" &&
          candidate.nativeWindow?.exists === true &&
          candidate.nativeWindow.visible === false &&
          candidate.nativeWindow.focused === false
          ? candidate
          : undefined;
      },
    );
    this.frontendAssetPreparation = await this.prepareFrontendAssets(
      candidate.page.nativeUrl,
    );
    this.recordControllerPageEvidence(true);
    return {
      ...candidate,
      frontendAssetPreparation: this.frontendAssetPreparation,
    };
  }

  async prepareFrontendAssets(nativeUrl) {
    const startedAtMs = Date.now();
    const controllerUrl = new URL(nativeUrl);
    if (
      controllerUrl.protocol !== "http:" ||
      controllerUrl.hostname !== "127.0.0.1" ||
      controllerUrl.pathname !== "/index.html" ||
      !controllerUrl.port
    ) {
      throw new Error("QA controller reported an invalid Vite origin");
    }
    const assets = ["/src/main.tsx", "/src/qa/hmuxWindowFocus.tsx"];
    const receipts = [];
    for (const asset of assets) {
      const url = new URL(asset, controllerUrl.origin);
      const response = await withHttpTimeout(
        `GET ${asset}`,
        (signal) => fetch(url, { signal }),
        FRONTEND_PREPARE_HTTP_TIMEOUT_MS,
      );
      const body = await response.text();
      if (!response.ok || body.length === 0) {
        throw new Error(
          `frontend asset preparation failed for ${asset} (${response.status})`,
        );
      }
      receipts.push({ path: asset, status: response.status, bytes: body.length });
    }
    return {
      schemaVersion: 1,
      state: "ready",
      elapsedMs: Date.now() - startedAtMs,
      assets: receipts,
    };
  }

  async start(profile = "smoke", { provider, screenModel } = {}) {
    const proof = crypto.randomBytes(32).toString("hex");
    this.proof = proof;
    const started = await this.request(
      "POST",
      "/qa/hmux/window-focus/start",
      {
        profile,
        proof,
        ...(provider ? { provider } : {}),
        ...(screenModel ? { screenModel } : {}),
      },
    );
    if (started.proof !== proof) {
      throw new Error("QA start response did not preserve the requested proof");
    }
    return started;
  }

  async prepareRuntime() {
    const startedAtMs = Date.now();
    this.runtimePreparation = {
      schemaVersion: 1,
      kind: "fixture_setup",
      state: "preparing",
      attempts: 1,
      elapsedMs: 0,
    };
    this.recordRuntimePreparationEvidence();
    try {
      const prepared = await this.request(
        "POST",
        "/qa/hmux/runtime/prepare",
        undefined,
        RUNTIME_PREPARE_HTTP_TIMEOUT_MS,
      );
      if (
        prepared.schemaVersion !== 1 ||
        prepared.kind !== "fixture_setup" ||
        typeof prepared.buildId !== "string" ||
        prepared.buildId.length === 0
      ) {
        throw new Error("runtime preparation returned an invalid receipt");
      }
      const expectedBuildId = process.env.DURE_QA_EXPECTED_HMUX_BUILD_ID;
      if (expectedBuildId && prepared.buildId !== expectedBuildId) {
        throw new Error(
          `runtime preparation selected ${prepared.buildId}; expected staged build ${expectedBuildId}`,
        );
      }
      this.runtimePreparation = {
        schemaVersion: 1,
        kind: "fixture_setup",
        state: "ready",
        buildId: prepared.buildId,
        attempts: 1,
        elapsedMs: Date.now() - startedAtMs,
      };
      this.recordRuntimePreparationEvidence();
      return this.runtimePreparation;
    } catch (error) {
      this.runtimePreparation = {
        schemaVersion: 1,
        kind: "fixture_setup",
        state: "failed",
        attempts: 1,
        elapsedMs: Date.now() - startedAtMs,
        lastError: String(error).slice(0, 2_048),
      };
      this.recordRuntimePreparationEvidence();
      throw error;
    }
  }

  async finish() {
    if (!this.descriptor || !this.proof) return;
    const proof = this.proof;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.request("POST", "/qa/hmux/window-focus/finish", { proof });
        this.proof = undefined;
        return;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }
    throw lastError;
  }

  async waitReady({
    primeRoles = ["a", "b", "a"],
    readyRoles = WINDOW_ROLES,
  } = {}) {
    await this.waitFor(
      `listening QA terminal windows ${readyRoles.join(",")}`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        return readyRoles.every((role) => {
          const window = candidate.windows?.[role];
          return window?.listening;
        })
          ? candidate
          : undefined;
      },
    );
    // A newly opened inactive WKWebView can keep its document hidden, and the
    // product correctly releases hidden terminal surfaces. The existing focus
    // action activates that document; only its QA event listener must predate it.
    // A deterministically presents the canonical Host geometry. B still
    // exercises keyboard controller transfer, then A is restored as the final
    // focused window.
    for (const role of primeRoles) await this.prime(role);
    return this.waitFor(
      `synchronized QA terminal windows ${readyRoles.join(",")}`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        return readyRoles.every((role) => {
          const window = candidate.windows?.[role];
          return window?.mounted && window.synchronized && !window.hydrating;
        })
          ? candidate
          : undefined;
      },
    );
  }

  async waitHiddenSurfaceRelease() {
    return this.waitFor(
      "two released hidden QA terminal windows",
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        const nativeWindowsReady = WINDOW_ROLES.every(
          (role) =>
            candidate.nativeWindows?.[role]?.exists === true &&
            candidate.nativeWindows[role].visible === false &&
            candidate.nativeWindows[role].focused === false,
        );
        const controllerWindowReady =
          candidate.controllerWindow?.exists === true &&
          candidate.controllerWindow.visible === false &&
          candidate.controllerWindow.focused === false;
        return WINDOW_ROLES.every((role) => {
          const window = candidate.windows?.[role];
          const latestAttachment = window?.latestSurfaceAttachmentId;
          return (
            window?.listening &&
            !window.mounted &&
            (latestAttachment == null ||
              window.latestRetiredSurfaceAttachmentId === latestAttachment) &&
            window.documentFocused === false
          );
        }) &&
          candidate.presentation === "hidden" &&
          nativeWindowsReady &&
          controllerWindowReady
          ? candidate
          : undefined;
      },
    );
  }

  async prime(role) {
    const action = await this.request(
      "POST",
      "/qa/hmux/window-focus/focus",
      { proof: this.requireProof(), window: role },
    );
    return this.waitFor(
      `window ${role.toUpperCase()} controller initialization`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        const target = candidate.windows?.[role];
        return target?.completedActionId === action.actionId &&
          target.synchronized &&
          !target.hydrating
          ? candidate
          : undefined;
      },
    );
  }

  async focusedStep(role) {
    return (await this.measuredFocusedStep(role)).status;
  }

  async focusReleaseInputStep(role = "a") {
    const action = await this.request("POST", "/qa/hmux/window-focus/step", {
      proof: this.requireProof(),
      window: role,
    });
    const waiting = await this.waitFor(
      `delayed terminal input under Sessions search in window ${role.toUpperCase()}`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        const target = candidate.windows?.[role];
        return target?.receivedActionId === action.actionId &&
          target.completedActionId !== action.actionId &&
          (target.markerCounts?.[action.marker] ?? 0) === 0
          ? candidate
          : undefined;
      },
    );
    const whileSearchOwned = await this.snapshotEvidence();
    if ((whileSearchOwned.markerCounts?.[action.marker] ?? 0) !== 0) {
      throw new Error(
        `delayed terminal input reached the Host while Sessions search owned the keyboard: ${JSON.stringify({ action, waiting, whileSearchOwned })}`,
      );
    }
    const status = await this.waitFor(
      `terminal text handoff from Sessions search in window ${role.toUpperCase()}`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        const target = candidate.windows?.[role];
        return target?.receivedActionId === action.actionId &&
          target.completedActionId === action.actionId &&
          WINDOW_ROLES.every(
            (candidateRole) =>
              candidate.windows?.[candidateRole]?.markerCounts?.[
                action.marker
              ] === 1,
          )
          ? candidate
          : undefined;
      },
    );
    const host = await this.snapshotEvidence();
    if (host.markerCounts?.[action.marker] !== 1) {
      throw new Error(
        `terminal text handoff marker was not canonical exactly once: ${JSON.stringify({ action, host, status })}`,
      );
    }
    return {
      action,
      host,
      status,
      waiting,
      whileSearchOwned,
    };
  }

  async measuredFocusedStep(role, { requiredRoles = WINDOW_ROLES } = {}) {
    const unfocusedRoles = requiredRoles.filter(
      (candidate) => candidate !== role,
    );
    const actionStartedAtMs = Date.now();
    const action = await this.request("POST", "/qa/hmux/window-focus/step", {
      proof: this.requireProof(),
      window: role,
    });
    const observed = await this.waitForMarker(action, {
      completedRole: role,
      requiredRoles,
      unfocusedRoles,
      paintedRole: role,
    });
    const receipt = observed.status.windows?.[role]?.markerWriteReceipts?.[
      action.marker
    ];
    const hostReceiptObservation = receipt?.observationAtHostReceipt;
    const projectionCommitAtMs = observed.firstSeenAtMs?.[role];
    const echoPaintAtMs = observed.firstPaintAtMs?.[role];
    if (
      !receipt ||
      !hostReceiptObservation ||
      typeof receipt.attachmentIdentity !== "string" ||
      receipt.attachmentIdentity.length === 0 ||
      !Number.isFinite(receipt.inputStartedAtMs) ||
      !Number.isFinite(receipt.hostReceiptAtMs) ||
      !Number.isFinite(hostReceiptObservation.snapshotCollapses) ||
      !Number.isFinite(hostReceiptObservation.scrollbackRows) ||
      !Number.isFinite(hostReceiptObservation.visibleFrameCount) ||
      !Number.isFinite(hostReceiptObservation.visibleFrameViolations) ||
      typeof hostReceiptObservation.atBottom !== "boolean" ||
      typeof hostReceiptObservation.concealed !== "boolean" ||
      typeof hostReceiptObservation.historyHydrating !== "boolean" ||
      !Number.isFinite(projectionCommitAtMs) ||
      !Number.isFinite(echoPaintAtMs) ||
      receipt.inputStartedAtMs < actionStartedAtMs ||
      receipt.hostReceiptAtMs < receipt.inputStartedAtMs ||
      projectionCommitAtMs < receipt.inputStartedAtMs ||
      echoPaintAtMs < projectionCommitAtMs
    ) {
      throw new Error(
        `invalid terminal input latency evidence: ${JSON.stringify({ role, action, receipt, projectionCommitAtMs, echoPaintAtMs })}`,
      );
    }
    return {
      status: observed.status,
      action,
      attachmentIdentity: receipt.attachmentIdentity,
      hostReceiptObservation,
      timing: {
        actionToInputStartMs:
          receipt.inputStartedAtMs - actionStartedAtMs,
        actionToHostReceiptMs:
          receipt.hostReceiptAtMs - actionStartedAtMs,
        actionToProjectionCommitMs:
          projectionCommitAtMs - actionStartedAtMs,
        actionToEchoPaintMs: echoPaintAtMs - actionStartedAtMs,
        inputToHostReceiptMs:
          receipt.hostReceiptAtMs - receipt.inputStartedAtMs,
        inputToEchoPaintMs: echoPaintAtMs - receipt.inputStartedAtMs,
        hostReceiptToEchoPaintMs: echoPaintAtMs - receipt.hostReceiptAtMs,
        inputToProjectionCommitMs:
          projectionCommitAtMs - receipt.inputStartedAtMs,
        hostReceiptToProjectionCommitMs:
          projectionCommitAtMs - receipt.hostReceiptAtMs,
        projectionCommitToEchoPaintMs: echoPaintAtMs - projectionCommitAtMs,
      },
    };
  }

  async inject() {
    return this.request("POST", "/qa/hmux/window-focus/inject", {
      proof: this.requireProof(),
    });
  }

  async setPresentation(presentation) {
    return this.request("POST", "/qa/hmux/window-focus/presentation", {
      proof: this.requireProof(),
      presentation,
    });
  }

  async resize(role, size) {
    return this.request("POST", "/qa/hmux/window-focus/resize", {
      proof: this.requireProof(),
      window: role,
      size,
    });
  }

  async scrollRows(role, rows) {
    if (!WINDOW_ROLES.includes(role) || !Number.isInteger(rows) || rows === 0) {
      throw new Error(`invalid QA viewport scroll: ${JSON.stringify({ role, rows })}`);
    }
    const action = await this.request(
      "POST",
      "/qa/hmux/window-focus/scroll-rows",
      {
        proof: this.requireProof(),
        window: role,
        rows,
      },
    );
    const status = await this.waitFor(
      `window ${role.toUpperCase()} Host viewport scroll ${rows}`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        const target = candidate.windows?.[role];
        return target?.receivedActionId === action.actionId &&
          target.completedActionId === action.actionId
          ? candidate
          : undefined;
      },
    );
    return { action, status };
  }

  async close(role) {
    return this.request("POST", "/qa/hmux/window-focus/close", {
      proof: this.requireProof(),
      window: role,
    });
  }

  async openLargeView() {
    return this.request("POST", "/qa/hmux/window-focus/open-large-view", {
      proof: this.requireProof(),
    });
  }

  async activateResizeRender() {
    return this.request(
      "POST",
      "/qa/hmux/window-focus/resize-render/activate",
      { proof: this.requireProof() },
    );
  }

  async restartWebview(role) {
    return this.request("POST", "/qa/hmux/window-focus/restart", {
      proof: this.requireProof(),
      window: role,
    });
  }

  async waitForWebviewRecovery(action) {
    return this.waitFor(
      `window ${action.window.toUpperCase()} WebView recovery`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        const target = candidate.windows?.[action.window];
        const nativeWindow = candidate.nativeWindows?.[action.window];
        if (
          !target ||
          target.webviewInstanceId === action.previousWebviewInstanceId ||
          !target.mounted ||
          !target.listening ||
          !target.synchronized ||
          target.hydrating ||
          nativeWindow?.visible !== true
        ) {
          return undefined;
        }
        return {
          status: candidate,
          recoveryMs: Math.max(0, Date.now() - action.issuedAtMs),
          webview: {
            previousInstanceId: action.previousWebviewInstanceId,
            instanceId: target.webviewInstanceId,
            startedAt: target.webviewStartedAt,
            uptimeMs: target.webviewUptimeMs,
          },
        };
      },
    );
  }

  async waitForBufferState(role, description, predicate) {
    return this.waitFor(description, WINDOW_TIMEOUT_MS, async () => {
      const candidate = await this.status();
      const state = candidate.windows?.[role]?.bufferState;
      return state && predicate(state, candidate) ? candidate : undefined;
    });
  }

  async waitUnfocused() {
    return this.waitFor(
      "both QA terminal windows to release OS focus",
      WINDOW_TIMEOUT_MS,
      async () => {
        const candidate = await this.status();
        return WINDOW_ROLES.every(
          (role) => candidate.windows?.[role]?.documentFocused === false,
        )
          ? candidate
          : undefined;
      },
    );
  }

  async waitForMarker(
    action,
    {
      completedRole,
      requiredRoles = WINDOW_ROLES,
      unfocusedRoles = WINDOW_ROLES,
      paintedRole,
    } = {},
  ) {
    let observed;
    try {
      observed = await this.waitFor(
        `${action.marker} through PTY, observers, and complete projections`,
        WINDOW_TIMEOUT_MS,
        async () => {
          const candidate = await this.status();
          const completed = completedRole
            ? candidate.windows?.[completedRole]
            : undefined;
          if (
            completedRole &&
            (completed?.completedActionId !== action.actionId ||
              completed.markerWriteReceipts?.[action.marker]?.state !==
                "written_to_pty")
          ) {
            return undefined;
          }
          if (
            !requiredRoles.every(
              (role) =>
                candidate.windows?.[role]?.markerCounts?.[action.marker] === 1,
            )
          ) {
            return undefined;
          }
          if (
            paintedRole &&
            !Number.isFinite(
              candidate.windows?.[paintedRole]?.firstPaintAtMs?.[action.marker],
            )
          ) {
            return undefined;
          }
          const firstSeenAtMs = Object.fromEntries(
            requiredRoles.map((role) => [
              role,
              candidate.windows[role].firstSeenAtMs[action.marker],
            ]),
          );
          const firstPaintAtMs = paintedRole
            ? {
                [paintedRole]:
                  candidate.windows[paintedRole].firstPaintAtMs[action.marker],
              }
            : {};
          return { status: candidate, firstSeenAtMs, firstPaintAtMs };
        },
      );
    } catch (error) {
      const host = await this.snapshotEvidence().catch((snapshotError) => ({
        error: String(snapshotError),
      }));
      const evidence = this.markerPipelineEvidence(action, host);
      this.recordMarkerPipelineEvidence(evidence);
      throw new Error(
        `${error}; marker pipeline: ${JSON.stringify(evidence)}`,
      );
    }
    const host = await this.snapshotEvidence();
    if (host.markerCounts?.[action.marker] !== 1) {
      const evidence = this.markerPipelineEvidence(action, host);
      this.recordMarkerPipelineEvidence(evidence);
      throw new Error(
        `${action.marker} was not present exactly once in the Host canonical snapshot; marker pipeline: ${JSON.stringify(evidence)}`,
      );
    }
    for (const role of unfocusedRoles) {
      if (
        observed.status.windows?.[role]?.firstSeenFocused?.[action.marker] !==
        false
      ) {
        throw new Error(
          `${role.toUpperCase()} first painted ${action.marker} while focused`,
        );
      }
    }
    return observed;
  }

  async waitForHostMarker(action) {
    return this.waitFor(
      `${action.marker} exactly once in the Host canonical snapshot`,
      WINDOW_TIMEOUT_MS,
      async () => {
        const snapshot = await this.snapshotEvidence();
        return snapshot.markerCounts?.[action.marker] === 1
          ? snapshot
          : undefined;
      },
    );
  }

  markerPipelineEvidence(action, host) {
    const status = this.lastWindowStatus;
    return {
      action: {
        actionId: action.actionId,
        marker: action.marker,
        window: action.window,
      },
      host: {
        sequenceThrough: host?.sequenceThrough,
        markerCount: host?.markerCounts?.[action.marker],
        truncated: host?.truncated,
        error: host?.error,
      },
      terminalSurfaceCount: status?.terminalSurfaceCount,
      windows: Object.fromEntries(
        WINDOW_ROLES.map((role) => {
          const report = status?.windows?.[role];
          return [
            role,
            {
              receivedActionId: report?.receivedActionId,
              completedActionId: report?.completedActionId,
              writeReceipt: report?.markerWriteReceipts?.[action.marker],
              completeProjectionObserved:
                report?.transportMarkers?.[action.marker] === true,
              projectionCount: report?.markerCounts?.[action.marker] ?? 0,
              renderMetrics: report?.renderMetrics,
              errors: report?.errors,
            },
          ];
        }),
      ),
    };
  }

  async status() {
    const candidate = await this.request(
      "GET",
      `/qa/hmux/window-focus/status?proof=${encodeURIComponent(
        this.requireProof(),
      )}`,
    );
    this.lastWindowStatus = candidate;
    this.recordStatusEvidence(candidate);
    this.assertNoErrors(candidate);
    return candidate;
  }

  async ping() {
    return this.request("GET", "/ping");
  }

  async performanceReport() {
    const receipt = await this.request("POST", "/perf/report", {
      projection: "terminal-input",
    });
    if (
      receipt.projection !== "terminal-input" ||
      receipt.report?.projection !== "terminal-input"
    ) {
      throw new Error("performance report omitted multi-window input evidence");
    }
    return receipt;
  }

  async snapshotEvidence() {
    return this.request(
      "GET",
      `/qa/hmux/window-focus/snapshot?proof=${encodeURIComponent(
        this.requireProof(),
      )}`,
    );
  }

  async waitFor(description, timeoutMs, read) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const value = await read();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    if (this.lastWindowStatus) {
      this.recordStatusEvidence(this.lastWindowStatus, true);
    } else if (this.lastControllerPageStatus) {
      this.recordControllerPageEvidence(true);
    }
    const lastBackendStatus =
      this.lastWindowStatus ?? this.lastControllerPageStatus;
    throw new Error(
      `timed out waiting for ${description}${
        lastError ? `: ${lastError}` : ""
      }; last backend status: ${JSON.stringify(lastBackendStatus)}`,
    );
  }

  async request(method, route, body, timeoutMs = HTTP_TIMEOUT_MS) {
    if (!this.descriptor) throw new Error("QA server is not connected");
    const routeLabel = qaHttpRouteLabel(route);
    const { response, value } = await withHttpTimeout(
      `${method} ${routeLabel}`,
      async (signal) => {
        const response = await fetch(
          `http://127.0.0.1:${this.descriptor.port}${route}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${this.descriptor.token}`,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal,
          },
        );
        const responseBody = await response.text();
        let value;
        try {
          value = JSON.parse(responseBody);
        } catch (error) {
          throw new Error(
            `${method} ${routeLabel} returned invalid JSON (${response.status})`,
            { cause: error },
          );
        }
        return { response, value };
      },
      timeoutMs,
    );
    if (!response.ok || value.ok === false) {
      throw new Error(
        `${method} ${routeLabel} failed (${response.status}): ${JSON.stringify(
          value,
        )}`,
      );
    }
    return value;
  }

  writeEvidence(filename, value) {
    if (!this.evidenceDir) return;
    try {
      fs.mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
      const destination = path.join(this.evidenceDir, filename);
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (this.evidenceWriteWarningShown) return;
      this.evidenceWriteWarningShown = true;
      console.error(`QA evidence status write failed: ${error}`);
    }
  }

  recordStatusEvidence(candidate, force = false) {
    const now = Date.now();
    if (!force && now < this.nextEvidenceStatusWriteAt) return;
    this.writeEvidence(
      "last-status.json",
      this.execution.decorate(this.evidenceStatus(candidate)),
    );
    this.nextEvidenceStatusWriteAt = now + EVIDENCE_STATUS_INTERVAL_MS;
  }

  recordExecutionEvidence() {
    this.writeEvidence(
      "last-status.json",
      this.execution.decorate(
        this.evidenceStatus(
          this.lastWindowStatus ?? {
            schemaVersion: 1,
            available: false,
            reason: "backend-status-not-recorded",
          },
        ),
      ),
    );
  }

  recordControllerPageEvidence(force = false) {
    const now = Date.now();
    if (!force && now < this.nextEvidenceStatusWriteAt) return;
    this.recordExecutionEvidence();
    this.nextEvidenceStatusWriteAt = now + EVIDENCE_STATUS_INTERVAL_MS;
  }

  recordMarkerPipelineEvidence(evidence) {
    this.latestMarkerPipeline = evidence;
    this.writeEvidence(
      "last-status.json",
      this.execution.decorate(
        this.evidenceStatus(this.lastWindowStatus ?? {}),
      ),
    );
  }

  recordRuntimePreparationEvidence() {
    this.writeEvidence("runtime-preparation.json", this.runtimePreparation);
    this.writeEvidence(
      "last-status.json",
      this.execution.decorate(
        this.evidenceStatus(this.lastWindowStatus ?? {}),
      ),
    );
  }

  evidenceStatus(candidate) {
    return {
      ...candidate,
      ...(this.lastControllerPageStatus
        ? { controllerPageReadiness: this.lastControllerPageStatus }
        : {}),
      ...(this.frontendAssetPreparation
        ? { frontendAssetPreparation: this.frontendAssetPreparation }
        : {}),
      ...(this.runtimePreparation
        ? { runtimePreparation: this.runtimePreparation }
        : {}),
      ...(this.latestMarkerPipeline
        ? { markerPipeline: this.latestMarkerPipeline }
        : {}),
    };
  }

  assertNoErrors(candidate) {
    for (const role of WINDOW_ROLES) {
      const errors = candidate.windows?.[role]?.errors ?? [];
      if (errors.length > 0) {
        this.recordStatusEvidence(candidate, true);
        throw new Error(
          `window ${role.toUpperCase()} reported errors: ${errors.join("; ")}`,
        );
      }
    }
  }

  requireProof() {
    if (!this.proof) throw new Error("QA run has not started");
    return this.proof;
  }
}
