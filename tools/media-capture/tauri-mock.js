(() => {
  let callbackId = 0;
  const callbacks = new Map();
  const config = window.__DURE_MEDIA_CAPTURE_CONFIG__ ?? {};
  const nativeWindowBridge =
    window.__DURE_MEDIA_CAPTURE_NATIVE_WINDOW_BRIDGE__ ?? null;
  const fixture = config.fixture ?? {};
  const terminalSurfaceSelectors = config.terminalSurfaceSelectors;
  if (
    !["host", "input", "paintedViewport", "presentation", "row", "viewport"].every(
      (key) => typeof terminalSurfaceSelectors?.[key] === "string",
    )
  ) {
    throw new Error("media fixture terminal surface contract is missing");
  }
  const providerDefaultsRoute = {
    schemaVersion: 1,
    profileId: "local",
    revision: `sha256:${"a".repeat(64)}`,
    backend: { id: fixture.productTour ? "dure-local" : "media-backend", generation: "media-generation" },
    target: { source: "local", hostId: "local" },
  };
  let providerDefaultsDocument = {
    schemaVersion: 1,
    revision: 1,
    defaults: {},
    fingerprint: `sha256:${"b".repeat(64)}`,
  };
  const terminalSnapshots = { ...(fixture.terminalSnapshots ?? {}) };
  const terminalScreensByCwd = fixture.terminalScreensByCwd ?? {};
  const terminalCwds = new Map();
  const terminalSnapshotOffsets = new Map();
  const terminalSnapshotGeometry = new Map(
    Object.entries(fixture.terminalSnapshotGeometry ?? {}),
  );
  const defaultTerminalSnapshotGeometry =
    fixture.defaultTerminalSnapshotGeometry ?? { columns: 71, rows: 26 };
  const fixedTerminalSnapshotGeometry = new Set(
    fixture.fixedTerminalSnapshotIds ??
      Object.keys(fixture.terminalSnapshotGeometry ?? {}),
  );
  const terminalViewportGeometry = new Map();
  const terminalSnapshotResumes = new Map();
  const terminalRenderProbes = new Map();
  const outputConsumers = new Map();
  const eventListeners = new Map();
  const diffBadges = fixture.diffBadges ?? {};
  const diffReviews = fixture.diffReviews ?? {};
  const reviewTargets = new Map();
  const hmuxSessions = new Map();
  const remoteHmuxSessions = new Map();
  const remoteHmuxOutputSequences = new Map();
  const hmuxClientSessions = new Map();
  const structuredTerminalRecords = new Map();
  const structuredTerminalWaiters = new Map();
  const structuredTerminalProjectionRevisions = new Map();
  let structuredTerminalCodecValue = fixture.structuredTerminalCodec ?? null;
  let structuredTerminalCodecPromise = null;
  const commandCounts = new Map();
  const hmuxConnectionDiagnostics = [];
  const clipboardImagePasteFixture =
    fixture.clipboardImagePaste?.schemaVersion === 1
      ? fixture.clipboardImagePaste
      : null;
  const clipboardImagePasteUploads = [];
  const clipboardImagePasteWrites = [];
  const headlessSpawnFixture =
    fixture.headlessSpawn?.schemaVersion === 1 ? fixture.headlessSpawn : null;
  const headlessSpawnReceipts = new Map();
  const headlessSpawnRequests = [];
  const headlessSpawnPresentations = [];
  const headlessSpawnWorktreeCommands = [];
  const headlessSpawnWorktreeCreations = [];
  const headlessSpawnWorktreeStatusReads = [];
  let headlessSpawnRuntimeSessionId = null;
  let productTourRuntimeSessionId = null;
  let headlessSpawnTerminalSessionId = null;
  const orchestrationChannelFixture =
    fixture.orchestrationChannel?.schemaVersion === 1
      ? fixture.orchestrationChannel
      : null;
  const orchestrationChannelAdvances = [];
  const orchestrationChannelPresentations = [];
  let orchestrationTerminalSessionId = null;
  const recoveryFixture =
    fixture.sessionRecovery?.schemaVersion === 1
      ? fixture.sessionRecovery
      : null;
  const recoveryStageKey = "dure-media-session-recovery-stage-v1";
  const recoveryStage = () =>
    window.sessionStorage?.getItem?.(recoveryStageKey) ?? "live";

  const recoverySourceSummary = (stage = recoveryStage()) => {
    if (!recoveryFixture) return null;
    const base = {
      ...recoveryFixture.source,
      sessionClass: "standalone",
      manifestLifecycle: "ready",
      clientSelection: "direct_rust",
      runtimeHost: "local",
      capabilities: [
        "terminal.screen-snapshot-v1",
        "terminal.atomic-screen-resume-v1",
      ],
    };
    if (stage === "live") {
      return {
        ...base,
        lifecycle: "ready",
        health: "current_healthy",
        inputAllowed: true,
        detachOnly: false,
        hostProcessAlive: true,
      };
    }
    if (stage === "restored") {
      return {
        ...base,
        lifecycle: "exited",
        manifestLifecycle: "exited",
        health: "exited",
        inputAllowed: false,
        detachOnly: true,
        hostProcessAlive: false,
      };
    }
    return {
      ...base,
      lifecycle: "unavailable",
      health: "stale_transport",
      inputAllowed: false,
      detachOnly: true,
      hostProcessAlive: false,
    };
  };

  const recoveryReplacementSummary = () =>
    recoveryFixture
      ? {
          ...recoveryFixture.replacement,
          sessionClass: "standalone",
          lifecycle: "ready",
          manifestLifecycle: "ready",
          health: "current_healthy",
          clientSelection: "direct_rust",
          inputAllowed: true,
          detachOnly: false,
          hostProcessAlive: true,
          runtimeHost: "local",
          capabilities: [
            "terminal.screen-snapshot-v1",
            "terminal.atomic-screen-resume-v1",
          ],
        }
      : null;

  const synchronizeRecoverySessions = () => {
    if (!recoveryFixture) return;
    const source = recoverySourceSummary();
    hmuxSessions.set(source.sessionId, source);
    const replacement = recoveryReplacementSummary();
    if (recoveryStage() === "restored") {
      hmuxSessions.set(replacement.sessionId, replacement);
    } else {
      hmuxSessions.delete(replacement.sessionId);
    }
  };

  const utf8Base64 = (value) => {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  const snapshot = (id) => {
    // A newly-created plain terminal can publish its first snapshot before
    // the renderer emits its initial resize. The bytes still use the fixture's
    // declared default grid, so record that source geometry at the same
    // authority boundary instead of leaving a visible terminal unprovable.
    if (id && !terminalSnapshotGeometry.has(id)) {
      terminalSnapshotGeometry.set(id, {
        ...defaultTerminalSnapshotGeometry,
      });
    }
    const content =
      terminalSnapshots[id] ??
      terminalScreensByCwd[terminalCwds.get(id)] ??
      [
        "\u001b[1;32mdure \u001b[0m\u001b[2m· release-check\u001b[0m",
        "",
        "$ pnpm test:smoke --changed",
        "Running changed-scope release checks…",
        "  ✓ session recovery      42 tests",
        "  ✓ SSH reconnect         18 tests",
        "  ✓ workspace restore     27 tests",
        "",
        "$ git status --short",
        " M docs/public/en/quickstart.mdx",
        "?? docs/public/images/workspace-overview.png",
        "",
        "\u001b[2mWatching for changes · release evidence ready\u001b[0m",
        "$ ",
      ].join("\r\n");
    const contentLength = new TextEncoder().encode(content).length;
    const endOffset = Math.max(
      contentLength,
      terminalSnapshotOffsets.get(id) ?? 0,
    );
    terminalSnapshotOffsets.set(id, endOffset);
    return {
      data: utf8Base64(content),
      endOffset,
    };
  };

  const structuredTerminalCodec = async () => {
    if (structuredTerminalCodecValue) return structuredTerminalCodecValue;
    structuredTerminalCodecPromise ??= Promise.all([
      import("/src/test/terminalRecordFixtures.ts"),
      import("/tools/media-capture/providers/privacy.mjs"),
      import("/src/lib/terminal/protocol/terminalStateProtocol.ts"),
      import("/tools/media-capture/runtime/colored-viewport.mjs"),
    ]).then(([records, privacy, protocol, colored]) => ({
      decodeTerminalStateRecord: protocol.decodeTerminalStateRecord,
      inputReceiptRecord: records.inputReceiptRecord,
      resizeAppliedReceiptRecord: records.resizeAppliedReceiptRecord,
      viewportFrameRecord: colored.coloredViewportFrameRecord,
      visibleProviderText: privacy.visibleProviderText,
    }));
    structuredTerminalCodecValue = await structuredTerminalCodecPromise;
    return structuredTerminalCodecValue;
  };

  const enqueueStructuredTerminalRecord = (observerId, record) => {
    const bytes =
      record instanceof Uint8Array ? record : new Uint8Array(record);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    const waiter = structuredTerminalWaiters.get(observerId);
    if (waiter) {
      structuredTerminalWaiters.delete(observerId);
      waiter(buffer);
      return;
    }
    const records = structuredTerminalRecords.get(observerId) ?? [];
    records.push(buffer);
    structuredTerminalRecords.set(observerId, records);
  };

  const nextStructuredTerminalRecord = (observerId) => {
    const records = structuredTerminalRecords.get(observerId) ?? [];
    const record = records.shift();
    if (record) return record;
    if (structuredTerminalWaiters.has(observerId)) {
      throw new Error(`structured terminal ${observerId} already has a pending pull`);
    }
    return new Promise((resolveRecord) => {
      structuredTerminalWaiters.set(observerId, resolveRecord);
    });
  };

  const encodeStructuredTerminalViewport = (
    session,
    { geometry: geometryOverride, projectionRevision } = {},
  ) => {
    if (!structuredTerminalCodecValue) {
      throw new Error("structured terminal codec is not ready");
    }
    const repaint = snapshot(session.sessionId);
    const screen = new TextDecoder().decode(
      Uint8Array.from(atob(repaint.data), (byte) => byte.charCodeAt(0)),
    );
    const geometry =
      geometryOverride ??
      terminalSnapshotGeometry.get(session.sessionId) ??
      defaultTerminalSnapshotGeometry;
    const visibleLines = structuredTerminalCodecValue
      .visibleProviderText(screen)
      .replaceAll("\r", "")
      .split("\n")
      .slice(-geometry.rows)
      .map((line) => Array.from(line).slice(0, geometry.columns).join(""));
    const texts = [
      ...visibleLines,
      ...Array.from(
        { length: Math.max(0, geometry.rows - visibleLines.length) },
        () => "",
      ),
    ];
    const revision =
      projectionRevision ?? BigInt(sessionOutputSequence(session));
    const previousRevision =
      structuredTerminalProjectionRevisions.get(session.sessionId) ?? 0n;
    if (revision > previousRevision) {
      structuredTerminalProjectionRevisions.set(session.sessionId, revision);
    }
    return structuredTerminalCodecValue.viewportFrameRecord({
      terminalEpoch: session.terminalEpoch,
      projectionRevision: revision,
      stateRevision: revision,
      throughOutputSeq: revision,
      columns: geometry.columns,
      texts,
      ansiScreen: screen,
      sourceRows: geometry.rows,
      cursorRow: Math.max(0, visibleLines.length - 1),
    });
  };

  const handleStructuredTerminalUpstream = (args = {}) => {
    if (!structuredTerminalCodecValue) {
      throw new Error("structured terminal codec is not ready");
    }
    const observerId = args.observerId;
    const session = clientSession(observerId);
    if (!session) {
      throw new Error(`structured terminal observer is missing: ${observerId}`);
    }
    const decoded = structuredTerminalCodecValue.decodeTerminalStateRecord(
      Uint8Array.from(args.record ?? []),
    );
    if (decoded.record.body.case !== "inputIntent") {
      return String(decoded.metadata.recordId);
    }
    const intent = decoded.record.body.value.intent;
    if (intent.case !== "resize") {
      enqueueStructuredTerminalRecord(
        observerId,
        structuredTerminalCodecValue.inputReceiptRecord(
          decoded.metadata.recordId,
          session.terminalEpoch,
          BigInt(sessionOutputSequence(session)),
        ),
      );
      return String(decoded.metadata.recordId);
    }
    const geometry = {
      columns: intent.value.columns,
      rows: intent.value.rows,
    };
    terminalViewportGeometry.set(session.sessionId, geometry);
    if (!fixedTerminalSnapshotGeometry.has(session.sessionId)) {
      terminalSnapshotGeometry.set(session.sessionId, geometry);
    }
    const currentRevision =
      structuredTerminalProjectionRevisions.get(session.sessionId) ??
      BigInt(sessionOutputSequence(session));
    const matchingRevision = currentRevision + 1n;
    enqueueStructuredTerminalRecord(
      observerId,
      encodeStructuredTerminalViewport(session, {
        geometry,
        projectionRevision: matchingRevision,
      }),
    );
    enqueueStructuredTerminalRecord(
      observerId,
      structuredTerminalCodecValue.resizeAppliedReceiptRecord(
        decoded.metadata.recordId,
        geometry.columns,
        geometry.rows,
        session.terminalEpoch,
      ),
    );
    enqueueStructuredTerminalRecord(
      observerId,
      encodeStructuredTerminalViewport(session, {
        geometry,
        projectionRevision: matchingRevision + 1n,
      }),
    );
    return String(decoded.metadata.recordId);
  };

  const recordTerminalWrite = (sessionId, data) => {
    if (!sessionId || typeof data !== "string") return;
    if (
      clipboardImagePasteFixture?.sessionId === sessionId &&
      data === `${clipboardImagePasteFixture.remotePath} `
    ) {
      clipboardImagePasteWrites.push({ data, sessionId });
      const current = snapshot(sessionId);
      const content = new TextDecoder().decode(
        Uint8Array.from(atob(current.data), (byte) => byte.charCodeAt(0)),
      );
      terminalSnapshots[sessionId] = `${content}${data}`;
    }
  };

  const headlessSpawnTerminalScreen = (receipt, complete = false) => {
    const state = complete ? receipt.state : "running";
    const worktreeContract = headlessSpawnFixture.worktree;
    const worktreeStep = receipt.steps.find(({ step }) => step === "worktree");
    const worktreeArtifact = worktreeStep?.artifacts?.find(
      ({ kind }) => kind === "worktree",
    );
    const steps = complete
      ? receipt.steps
          .filter(({ status }) => status === "ok" || status === "skipped")
          .map(({ status, step }) =>
            `${status === "ok" ? "\u001b[32m✓\u001b[0m" : "\u001b[2m–\u001b[0m"} ${step}`,
          )
      : ["\u001b[33m● journal accepted · saga running\u001b[0m"];
    return [
      "\u001b[2J\u001b[3J\u001b[H",
      `\u001b[1;32mdure\u001b[0m \u001b[2m· ${worktreeContract ? "dedicated worktree launch" : "headless orchestration"}\u001b[0m`,
      "",
      "$ curl -sS -X POST $DURE_URL/spawn/v2 \\",
      `    -d '{"project":"dure","provider":"codex","useWorktree":${Boolean(worktreeContract)}}'`,
      "\u001b[2mHTTP/1.1\u001b[0m \u001b[1;32m202 Accepted\u001b[0m",
      `{ \"ok\": true, \"receiptId\": \"${receipt.receiptId}\" }`,
      "",
      `$ dure spawn status ${receipt.receiptId}`,
      `state: \u001b[${complete ? "1;32" : "1;33"}m${state}\u001b[0m`,
      ...steps,
      ...(complete && worktreeArtifact && worktreeContract
        ? [
            "",
            `worktree: \u001b[1m${worktreeArtifact.id}\u001b[0m`,
            `branch:   \u001b[36m${worktreeArtifact.branch}\u001b[0m  \u001b[32m↑${worktreeContract.gitStatus.ahead}\u001b[0m  ${worktreeContract.gitStatus.staged + worktreeContract.gitStatus.unstaged + worktreeContract.gitStatus.untracked} changed`,
          ]
        : []),
      "",
      complete
        ? worktreeContract
          ? "\u001b[2mBranch, worktree, and pane joined by one durable receipt.\u001b[0m"
          : "\u001b[2mPane committed from the durable receipt.\u001b[0m"
        : "\u001b[2mThe UI remains free for other work.\u001b[0m",
    ].join("\r\n");
  };

  const orchestrationTerminalScreen = (phase) => {
    const statusColor = {
      todo: "37",
      dispatched: "33",
      "in-progress": "36",
      blocked: "31",
      done: "32",
    };
    const typeColor = {
      note: "37",
      dispatch: "36",
      heartbeat: "33",
      worker_done: "32",
      decision_gate: "35",
      escalation: "31",
    };
    const messages = phase.messageIds
      .map((id) => orchestrationChannelFixture.messages.find((message) => message.id === id))
      .filter(Boolean)
      .slice(-6);
    const commands = {
      queued: "$ MCP orchestration_events_read · cursor 0",
      dispatched: "$ MCP orchestration_interaction_open · Message",
      working: "$ MCP orchestration_events_read · reconnect cursor 3",
      decision: "$ MCP orchestration_interaction_get · Decision g1",
      resolved: "$ MCP orchestration_decision_answer · Select preserve",
    };
    const rows = [
      "\u001b[2J\u001b[3J\u001b[H",
      "\u001b[1;32mdure\u001b[0m \u001b[2m· shared orchestration channel\u001b[0m",
      `\u001b[2mphase ${phase.id} · durable typed messages\u001b[0m`,
      "",
      commands[phase.id],
      ...orchestrationChannelFixture.tasks.map((task) => {
        const status = phase.taskStates[task.id];
        return `[${task.id}] \u001b[${statusColor[status] ?? "37"}m${status.padEnd(12)}\u001b[0m ${task.title} @${task.assignee}`;
      }),
      "",
      "\u001b[2m────────────────────────────────────────────────────────────────\u001b[0m",
      `$ MCP orchestration_events_read · ${orchestrationChannelFixture.coordinator}`,
    ];
    if (messages.length === 0) {
      rows.push("\u001b[2mWaiting for typed worker reports…\u001b[0m");
    } else {
      for (const message of messages) {
        const color = typeColor[message.type] ?? "37";
        rows.push(
          `\u001b[${color}m●\u001b[0m [${message.id}] ${message.from} → ${message.to} \u001b[${color}m${message.type}\u001b[0m${message.taskId ? ` · ${message.taskId}` : ""}`,
          `  ${message.body}`,
        );
      }
    }
    if (phase.gateStatus) {
      const resolved = phase.gateStatus === "resolved";
      rows.push(
        "",
        `${resolved ? "\u001b[32m✓\u001b[0m" : "\u001b[33m⏸\u001b[0m"} [${orchestrationChannelFixture.gate.id}] ${orchestrationChannelFixture.gate.question}`,
        `  [${orchestrationChannelFixture.gate.options.join("/")}]${resolved ? ` → ${orchestrationChannelFixture.gate.resolution}` : ""}`,
      );
    }
    rows.push(
      "",
      `\u001b[2m${orchestrationChannelFixture.tasks.length} tasks · ${phase.messageIds.length} messages · one shared receipt ledger\u001b[0m`,
    );
    return rows.join("\r\n");
  };

  const initialHeadlessSpawnReceipt = (params) => ({
    v: 1,
    receiptId: headlessSpawnFixture.receiptId,
    idempotencyKey: null,
    request: structuredClone(params),
    steps: [],
    state: "running",
    updatedAt: Date.now(),
  });

  const receiptStep = (receipt, stepName) => {
    let step = receipt.steps.find((candidate) => candidate.step === stepName);
    if (!step) {
      step = { step: stepName, status: "pending" };
      receipt.steps.push(step);
    }
    return step;
  };

  const appendHeadlessSpawnJournal = (receiptId, event) => {
    const receipt = headlessSpawnReceipts.get(receiptId);
    if (!receipt) throw new Error(`media spawn receipt not found: ${receiptId}`);
    const stepName = typeof event?.step === "string" ? event.step : null;
    if (event?.event === "step_started" && stepName) {
      Object.assign(receiptStep(receipt, stepName), {
        status: "running",
        startedAt: Date.now(),
      });
    } else if (event?.event === "step_succeeded" && stepName) {
      const projection = {
        status: "ok",
        endedAt: Date.now(),
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
      if (
        stepName === "prompt_delivery" &&
        event.detail?.deliveryContract === "host_atomic_v1" &&
        event.detail?.receipt
      ) {
        projection.delivery = {
          state: "written_to_pty",
          promptDigest: event.detail.promptDigest,
          promptLen: event.detail.promptLen,
          receipt: structuredClone(event.detail.receipt),
        };
        projection.evidence = {
          level: "written_to_pty",
          detail: "exact Host initial-prompt receipt",
        };
      }
      Object.assign(receiptStep(receipt, stepName), projection);
    } else if (event?.event === "step_skipped" && stepName) {
      Object.assign(receiptStep(receipt, stepName), {
        status: "skipped",
        endedAt: Date.now(),
      });
    } else if (event?.event === "step_failed" && stepName) {
      Object.assign(receiptStep(receipt, stepName), {
        status: "failed",
        endedAt: Date.now(),
        error: structuredClone(event.error),
      });
    } else if (
      (event?.event === "artifact_created" ||
        event?.event === "artifact_adopted") &&
      stepName
    ) {
      const step = receiptStep(receipt, stepName);
      step.artifacts ??= [];
      step.artifacts.push({
        ...structuredClone(event.artifact),
        ownership:
          event.event === "artifact_created"
            ? "created_by_request"
            : "adopted",
      });
    } else if (event?.event === "evidence") {
      const running = [...receipt.steps]
        .reverse()
        .find(({ status }) => status === "running");
      if (running) running.evidence = structuredClone(event.evidence);
    } else if (event?.event === "saga_finished") {
      receipt.state = event.state;
    }
    receipt.updatedAt = Date.now();
    return structuredClone(receipt);
  };

  const hmuxSession = (args = {}) => {
    const sessionId = args.sessionId ?? "media-hmux-session";
    synchronizeRecoverySessions();
    const current = hmuxSessions.get(sessionId);
    if (current) return current;
    const terminalEpoch = `epoch-${sessionId}`;
    const session = {
      sessionId,
      workspaceId: args.workspaceId ?? `workspace-${sessionId}`,
      sessionClass: "managed",
      lifecycle: "ready",
      manifestLifecycle: "ready",
      health: "current_healthy",
      hostBuildVersion: config.backendCapabilities?.buildId ?? "media-fixture",
      clientSelection: "direct_rust",
      inputAllowed: true,
      detachOnly: false,
      hostProcessAlive: true,
      runtimeHost: "local",
      terminalEpoch,
      stopFence: {
        runnerPrincipal: "media-user",
        runnerInstance: `runner-${sessionId}`,
        channelEpoch: "1",
        hostInstanceId: `host-${sessionId}`,
        terminalEpoch,
      },
      outputSeq: "1",
      capabilities: [
        "terminal.screen-snapshot-v1",
        "terminal.atomic-screen-resume-v1",
      ],
    };
    hmuxSessions.set(sessionId, session);
    return session;
  };

  const managedCreateReceipt = (request = {}) => {
    if (request.sessionId) {
      if (headlessSpawnFixture) {
        const sourceId = headlessSpawnFixture.providerTarget.sessionId;
        headlessSpawnRuntimeSessionId = request.sessionId;
        if (terminalSnapshots[sourceId] !== undefined) {
          terminalSnapshots[request.sessionId] = terminalSnapshots[sourceId];
        }
        if (terminalSnapshotGeometry.has(sourceId)) {
          terminalSnapshotGeometry.set(
            request.sessionId,
            structuredClone(terminalSnapshotGeometry.get(sourceId)),
          );
          fixedTerminalSnapshotGeometry.add(request.sessionId);
        }
      }
      if (fixture.productTour) {
        productTourRuntimeSessionId = request.sessionId;
        const provider = JSON.stringify(request).includes("codex") ? "codex" : "claude";
        terminalSnapshots[request.sessionId] = terminalSnapshots["tour-session-new"] ?? fixture.productTour.screens[provider];
        const geometry = terminalSnapshotGeometry.get("tour-session-new");
        if (geometry) terminalSnapshotGeometry.set(request.sessionId, structuredClone(geometry));
      }
      terminalCwds.set(request.sessionId, request.cwd ?? "");
      bindTerminalHost(request.sessionId);
    }
    return {
      session: hmuxSession(request),
      idempotencyKey: request.idempotencyKey,
      cwd: request.cwd ?? "",
      outcome: "created",
      credentialId: request.credentialId ?? undefined,
      credentialGeneration: request.credentialGeneration ?? undefined,
    };
  };

  const initialAgentPromptReceipt = (request = {}) => {
    const session = request.session ?? {};
    return {
      ...(request.target?.hostId
        ? {
            hostId: request.target.hostId,
            sessionId: session.sessionId,
            workspaceId: session.workspaceId,
          }
        : {}),
      terminalEpoch:
        session.terminalEpoch ?? request.expectedFence?.terminalEpoch,
      recordId: "1",
      inputBaselineOutputSequence: "0",
      initialAgentRuntimeRevision: "1",
    };
  };

  const attachStructuredTerminalSession = async ({
    observerId,
    session,
    receiptSession = session,
  }) => {
    await structuredTerminalCodec();
    hmuxClientSessions.set(observerId, session.sessionId);
    structuredTerminalRecords.set(observerId, []);
    enqueueStructuredTerminalRecord(
      observerId,
      encodeStructuredTerminalViewport(session),
    );
    bindTerminalHost(session.sessionId);
    const revision = sessionOutputSequence(session);
    return {
      terminalEpoch: session.terminalEpoch,
      throughOutputSeq: revision,
      stateRevision: revision,
      initialDeliveryRecordCount: 1,
      selectedCapabilities: ["terminal_state_binary_v1"],
      session: receiptSession,
    };
  };

  const attachStructuredTerminal = async (args = {}) => {
    const session = hmuxSession(args);
    return attachStructuredTerminalSession({
      observerId: args.observerId,
      session,
    });
  };

  const attachRemoteStructuredTerminal = async (request = {}) => {
    const session = remoteHmuxSession(request);
    return attachStructuredTerminalSession({
      observerId: request.observerId,
      receiptSession: remoteSessionSummary(request),
      session,
    });
  };

  const detachStructuredTerminal = (observerId) => {
    hmuxClientSessions.delete(observerId);
    structuredTerminalRecords.delete(observerId);
    structuredTerminalWaiters.delete(observerId);
  };

  const remoteHmuxSession = (request = {}) => {
    const input = request.session ?? request;
    const sessionId = input.sessionId ?? "media-remote-session";
    const current = remoteHmuxSessions.get(sessionId);
    if (current) return current;
    const session = {
      sessionId,
      workspaceId: input.workspaceId ?? `workspace-${sessionId}`,
      sessionClass: input.sessionClass ?? "managed",
      lifecycle: "ready",
      providerId: input.providerId ?? "local-shell",
      runnerPrincipal: "media-user",
      runnerInstance: `runner-${sessionId}`,
      channelEpoch: "1",
      hostInstanceId: `host-${sessionId}`,
      terminalEpoch: `epoch-${sessionId}`,
      supportedProtocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 0 },
      },
      capabilities: ["ansi_redraw_v1", "terminal_input"],
    };
    remoteHmuxSessions.set(sessionId, session);
    remoteHmuxOutputSequences.set(sessionId, "1");
    return session;
  };

  const remoteSessionSummary = (request = {}) => {
    const remote = remoteHmuxSession(request);
    const target = request.target ?? {};
    return {
      sessionId: remote.sessionId,
      workspaceId: remote.workspaceId,
      sessionClass: remote.sessionClass,
      lifecycle: remote.lifecycle,
      manifestLifecycle: remote.lifecycle,
      health: "current_healthy",
      hostBuildVersion: config.backendCapabilities?.buildId ?? "media-fixture",
      clientSelection: "direct_rust",
      inputAllowed: true,
      detachOnly: false,
      hostProcessAlive: true,
      runtimeHost: target.hostId ?? "host-studio",
      terminalEpoch: remote.terminalEpoch,
      stopFence: {
        runnerPrincipal: remote.runnerPrincipal,
        runnerInstance: remote.runnerInstance,
        channelEpoch: remote.channelEpoch,
        hostInstanceId: remote.hostInstanceId,
        terminalEpoch: remote.terminalEpoch,
      },
      outputSeq: remoteHmuxOutputSequences.get(remote.sessionId) ?? "1",
      capabilities: [...remote.capabilities],
    };
  };

  const runCallback = (id, data) => {
    const entry = callbacks.get(id);
    if (!entry) return;
    entry.callback(data);
    if (entry.once) callbacks.delete(id);
  };

  const dispatchEvent = (event, payload) => {
    for (const eventId of eventListeners.get(event) ?? []) {
      runCallback(eventId, { event, id: eventId, payload });
    }
  };

  const registerOutputConsumer = (args) => {
    if (!args?.id || !args?.consumerId) return;
    const consumers = outputConsumers.get(args.id) ?? new Set();
    consumers.add(args.consumerId);
    outputConsumers.set(args.id, consumers);
    // Attach/create can race the React terminal host mount. Subscription is
    // the first boundary that proves the mounted TerminalView is consuming
    // this exact session, so retry the deterministic host binding here.
    bindTerminalHost(args.id);
  };

  const unregisterOutputConsumer = (args) => {
    const consumers = outputConsumers.get(args?.id);
    consumers?.delete(args?.consumerId);
    if (consumers?.size === 0) outputConsumers.delete(args.id);
  };

  const clientSession = (clientId) => {
    const sessionId = hmuxClientSessions.get(clientId);
    return sessionId
      ? (hmuxSessions.get(sessionId) ?? remoteHmuxSessions.get(sessionId))
      : undefined;
  };

  const sessionOutputSequence = (session) =>
    session?.outputSeq ??
    remoteHmuxOutputSequences.get(session?.sessionId) ??
    "1";

  const bindTerminalHost = (id) => {
    if (!id || typeof document === "undefined") return;
    const agents = window.__DURE_STORE__?.getState?.().agents ?? fixture.agents ?? [];
    const agent = agents.find((candidate) => candidate.sessionId === id);
    const matchingHosts = (window.__DURE_DOCK__?.mountedDockviewEntries?.() ?? [])
      .flatMap(([, api]) => (api.panels ?? []).filter((panel) => {
        const params = panel.params ?? panel.api.getParameters();
        return (agent && params?.agentRef?.agentId === agent.id) || params?.binding?.sessionId === id;
      }))
      .map((panel) => panel.group?.element?.querySelector?.(".terminal-host"))
      .filter(Boolean);
    if (matchingHosts.length > 0) {
      for (const host of matchingHosts) host.dataset.dureMediaSessionId = id;
      return;
    }
    if (
      [...document.querySelectorAll("[data-dure-media-session-id]")].some(
        (element) => element.dataset.dureMediaSessionId === id,
      )
    ) {
      return;
    }
    if (
      recoveryFixture &&
      id === recoveryFixture.replacement.sessionId
    ) {
      const sourceHost = [
        ...document.querySelectorAll("[data-dure-media-session-id]"),
      ].find(
        (element) =>
          element.dataset.dureMediaSessionId ===
          recoveryFixture.source.sessionId,
      );
      if (sourceHost) {
        sourceHost.dataset.dureMediaSessionId = id;
        return;
      }
    }
    const activeDesktopId = window.__DURE_STORE__?.getState?.().activeDesktopId;
    const activeDesktop = document.getElementById(
      `desktop-panel-${activeDesktopId}`,
    );
    const dedicatedSessionSurface = config.captureSurface === "session";
    const visible = [...document.querySelectorAll(".terminal-host")].filter(
      (element) => {
        if (element.dataset.dureMediaSessionId) return false;
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          (dedicatedSessionSurface || activeDesktop?.contains(element)) &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.right > 0 &&
          bounds.bottom > 0 &&
          bounds.left < window.innerWidth &&
          bounds.top < window.innerHeight &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      },
    );
    const host = visible.at(-1);
    if (host) host.dataset.dureMediaSessionId = id;
  };

  const gitStatus = (path) => {
    const worktreeContract = headlessSpawnFixture?.worktree;
    if (worktreeContract?.path === path) {
      const read = {
        path,
        status: structuredClone(worktreeContract.gitStatus),
      };
      headlessSpawnWorktreeStatusReads.push(read);
      return structuredClone(read.status);
    }
    const agent = (fixture.agents ?? []).find(
      (candidate) => candidate.worktreePath === path,
    );
    return (
      (agent && fixture.gitStatuses?.[agent.id]) ?? {
        isRepo: true,
        branch: "main",
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      }
    );
  };

  const diffReview = (path) => {
    const agent = (fixture.agents ?? []).find(
      (candidate) => candidate.worktreePath === path,
    );
    const review = agent ? diffReviews[agent.id] : null;
    if (!agent || !review) {
      throw new Error(`media fixture has no diff review for ${path}`);
    }
    return { agent, review };
  };

  const diffStat = (path) => {
    const agent = (fixture.agents ?? []).find(
      (candidate) => candidate.worktreePath === path,
    );
    const review = agent ? diffReviews[agent.id] : null;
    if (review) {
      return {
        baseRef: review.baseRef,
        mergeBase: review.mergeBase,
        files: review.files,
      };
    }
    const badge = agent ? diffBadges[agent.id] : null;
    return {
      baseRef: "origin/main",
      mergeBase: "9f47c2a18d67c31d4be26009b8c4f02c26eb9531",
      files: badge
        ? [
            {
              path: "docs/public/quickstart.mdx",
              oldPath: null,
              added: badge.added,
              deleted: badge.deleted,
              status: "M",
            },
          ]
        : [],
    };
  };

  function result(command, args) {
    synchronizeRecoverySessions();
    if (nativeWindowBridge?.handles(command)) {
      return nativeWindowBridge.invoke(command, args);
    }
    if (command === "system_font_families") return [];
    if (command === "git_availability") return { status: "available" };
    if (command === "dure_cli_install_status") {
      const identity = { version: "0.2.19", digest: "a".repeat(64), installRoot: "/opt/dure", executablePath: "/opt/dure/bin/dure" };
      return { state: "current", installed: identity, available: identity };
    }
    if (command === "run_shell" && args?.cmd?.includes("doctor")) {
      const details = ["claude", "codex"].map((provider) => ({
        provider, status: "current", installRoot: `/opt/dure/${provider}`, installRootRef: null, version: "0.2.19", digest: "a".repeat(64), channel: "stable", transportRef: null,
        capabilities: ["event_cursor_v1"], refreshCommand: null,
        ...Object.fromEntries(["fix", "update", "uninstall"].map((kind) => [`${kind}Command`, `dure integration ${kind === "fix" ? "install" : kind} --global --provider ${provider} --approve-global-config`])),
      }));
      return { stdout: JSON.stringify({ schemaVersion: 1, dependencies: [{ id: "orchestration-integration", label: "Agent integration", ok: true, updateCommand: "dure integration update --global --approve-global-config", uninstallCommand: "dure integration uninstall --global --approve-global-config", fixCommand: "dure integration install --global --approve-global-config", details }] }), stderr: "", code: 0 };
    }
    if (fixture.productTour) {
      if (command === "agent_name_suggestion") return "Session handoff";
      if (command === "list_branches") return [];
      if (command === "git_exec" || command === "git_exec_bounded") {
        const gitArgs = args?.args ?? [];
        const stdout = gitArgs[0] === "symbolic-ref" ? "origin/main\n" : gitArgs[0] === "rev-parse" ? `${"a".repeat(40)}\n` : "";
        return { stdout, stderr: "", code: 0 };
      }
      if (command === "dure_plugin_catalog_v2") return {
        schema_version: 2,
        outcomes: [{ status: "available", identity: { source_id: "dure.bundled", candidate_id: "dure.github.bundled" }, entry: fixture.productTour.plugin }],
      };
      if (command === "dure_backend_request" && args?.operation?.startsWith("agent_spawn.")) {
        if (args.operation === "agent_spawn.preview") {
          const session = hmuxSession({ sessionId: "session-run-1", workspaceId: "workspace-run-1", cwd: "/workspace/launchpad" });
          Object.assign(session, { terminalEpoch: "terminal-epoch", stopFence: { runnerPrincipal: "runner-principal", runnerInstance: "runner-instance", channelEpoch: "1", hostInstanceId: "host-instance", terminalEpoch: "terminal-epoch" } });
          productTourRuntimeSessionId = "session-run-1";
          terminalSnapshots["session-run-1"] = terminalSnapshots["tour-session-new"] ?? fixture.productTour.screens[args.body.providerId];
          const geometry = terminalSnapshotGeometry.get("tour-session-new");
          if (geometry) terminalSnapshotGeometry.set("session-run-1", structuredClone(geometry));
          terminalCwds.set("session-run-1", "/workspace/launchpad");
        }
        if (args.operation === "agent_spawn.apply" && args.body.prompt?.includes("GitHub issue #43")) {
          terminalSnapshots["session-run-1"] = terminalSnapshots["tour-session-new"] ?? fixture.productTour.screens.issue;
        }
        return window.__DURE_PRODUCT_TOUR_RUN__(args);
      }
      if (command === "gh_exec") {
        const ghArgs = args?.args ?? [];
        let value;
        if (ghArgs[0] === "auth") return { stdout: "github.com\n  ✓ Logged in to github.com account demo (keyring)\n  - Active account: true\n  - Token scopes: 'repo', 'read:org'", stderr: "", code: 0, timed_out: false, missing: false };
        if (ghArgs[0] === "repo") value = { nameWithOwner: "dure-demo/launchpad", url: "https://github.com/dure-demo/launchpad", owner: { login: "dure-demo" }, isInOrganization: true };
        else if (ghArgs[0] === "issue" && ghArgs[1] === "list") value = [
          { number: 43, title: "Review stale session handoff" }, { number: 42, title: "Cover empty search results" }, { number: 40, title: "Improve keyboard navigation" },
        ].map((row) => ({ ...row, id: `I_demo_${row.number}`, url: `https://github.com/dure-demo/launchpad/issues/${row.number}`, state: "OPEN", labels: [], assignees: [], author: null, updatedAt: "2026-07-31T09:25:00Z", createdAt: "2026-07-30T09:25:00Z" }));
        else value = [];
        return { stdout: JSON.stringify(value), stderr: "", code: 0, timed_out: false, missing: false };
      }
    }
    switch (command) {
      case "dure_backend_route_assert":
        return providerDefaultsRoute;
      case "dure_backend_request": {
        const body = args?.body;
        let result;
        if (args?.operation === "provider_launch_defaults.get") {
          result = { schemaVersion: 1, document: providerDefaultsDocument };
        } else if (args?.operation === "provider_launch_defaults.put") {
          const preserve = body.expectedRevision === 0;
          if (!preserve) {
            if (body.expectedRevision !== providerDefaultsDocument.revision) {
              throw new Error("media provider defaults revision conflict");
            }
            providerDefaultsDocument = {
              ...providerDefaultsDocument,
              revision: providerDefaultsDocument.revision + 1,
              defaults: body.defaults,
            };
          }
          result = {
            schemaVersion: 1,
            idempotencyKey: body.idempotencyKey,
            expectedRevision: body.expectedRevision,
            disposition: preserve ? "preserved_existing" : "updated",
            document: providerDefaultsDocument,
            updatedAtMs: 1,
          };
        } else {
          return null;
        }
        return {
          schemaVersion: 1,
          backendId: providerDefaultsRoute.backend.id,
          backendGeneration: providerDefaultsRoute.backend.generation,
          routeAuthority: providerDefaultsRoute,
          result,
        };
      }
      case "app_caps":
        return config.backendCapabilities ?? null;
      case "home_dir":
        return "/workspace";
      case "system_hardware_profile":
        return { logicalCores: 12, physicalMemoryBytes: 34_359_738_368 };
      case "control_plane_census":
      case "hmux_control_plane_census":
        return {
          policy: {
            currentBuildId:
              config.backendCapabilities?.buildId ?? "media-fixture",
            activation: "local_bundled_or_installed_current",
            signedReleaseFetch: "not_implemented",
            signedPackageInstall: "blocked_missing_trust_root",
          },
          sessions: [...hmuxSessions.values()],
          protectedBuildIds: [],
        };
      case "usage_recent":
        return {
          claude: { total: 18 },
          codex: { total: 24, usedPercent: 36 },
        };
      case "run_shell":
        return {
          stdout: [
            "claude\t/opt/dure/bin/claude",
            "codex\t/opt/dure/bin/codex",
            "kimi\t/opt/dure/bin/kimi",
          ].join("\n"),
          stderr: "",
          code: 0,
        };
      case "resolve_session_bin":
        return "";
      case "read_clipboard_image":
        return clipboardImagePasteFixture?.image ?? null;
      case "ssh_upload_image": {
        if (!clipboardImagePasteFixture) {
          throw new Error("media fixture has no SSH clipboard image paste");
        }
        if (
          args?.id !== clipboardImagePasteFixture.sessionId ||
          args?.dataB64 !== clipboardImagePasteFixture.image.dataB64 ||
          args?.ext !== clipboardImagePasteFixture.image.ext
        ) {
          throw new Error("SSH clipboard image upload did not match its fixture");
        }
        clipboardImagePasteUploads.push({
          bytes: atob(args.dataB64).length,
          ext: args.ext,
          remotePath: clipboardImagePasteFixture.remotePath,
          sessionId: args.id,
        });
        return clipboardImagePasteFixture.remotePath;
      }
      case "spawn_receipt_get": {
        const receipt = headlessSpawnReceipts.get(args?.receiptId);
        if (!receipt) {
          throw new Error(`media spawn receipt not found: ${args?.receiptId}`);
        }
        return structuredClone(receipt);
      }
      case "spawn_journal_append":
        return appendHeadlessSpawnJournal(args?.receiptId, args?.event);
      case "spawn_receipts_list_running":
        return [...headlessSpawnReceipts.values()]
          .filter(({ state }) => state === "running")
          .map((receipt) => structuredClone(receipt));
      case "provider_preflight":
        return {
          provider: args?.provider,
          command: args?.command,
          ready: true,
          status: "ready",
          message: `${args?.provider ?? "provider"} is ready`,
          shell: "/bin/zsh",
          cwd: args?.cwd ?? "/workspace",
          environmentSource: "login_shell",
          path: "/opt/dure/bin:/usr/bin:/bin",
          commandPath: `/opt/dure/bin/${args?.provider ?? "agent"}`,
          resolvedPath: `/opt/dure/bin/${args?.provider ?? "agent"}`,
          symlinkChain: [],
          executable: true,
          version: fixture.productTour ? "media-fixture" : "media-fixture 1.0.0",
          versionTimeoutMs: 2_000,
          inheritedNoColor: null,
          effectiveNoColor: null,
          recoveryRequiresUserApproval: false,
          suggestedRecovery: [],
        };
      case "pty_create":
        if (args?.id) {
          terminalCwds.set(args.id, args.cwd ?? "");
          bindTerminalHost(args.id);
        }
        return {
          created: false,
          generation: 1,
          launchToken: args?.launchToken ?? null,
        };
      case "pty_exists":
        return true;
      case "pty_generation":
        return 1;
      case "pty_resize":
      case "ssh_resize":
        if (args?.id) {
          bindTerminalHost(args.id);
          const geometry = {
            columns: args.cols,
            rows: args.rows,
          };
          terminalViewportGeometry.set(args.id, geometry);
          if (!fixedTerminalSnapshotGeometry.has(args.id)) {
            terminalSnapshotGeometry.set(args.id, geometry);
          }
        }
        return null;
      case "pty_screen_snapshot":
      case "pty_scrollback":
      case "ssh_screen_snapshot":
      case "ssh_scrollback":
        return snapshot(args?.id);
      case "persisted_scrollback":
      case "session_caps":
      case "session_agent":
      case "hebbian_read":
        return "";
      case "session_cwd":
        return terminalCwds.get(args?.id) ?? "";
      case "session_execution_target":
      case "session_hmux":
      case "session_hmux_projection":
        return null;
      case "session_output_resume":
        {
          const latestEndOffset = terminalSnapshotOffsets.get(args?.id) ?? 0;
          return {
            latestEndOffset,
            snapshotRequired: (args?.snapshotOffset ?? 0) < latestEndOffset,
          };
        }
      case "session_output_subscribe":
        {
          const latestEndOffset = terminalSnapshotOffsets.get(args?.id) ?? 0;
          const snapshotRequired =
            (args?.startOffset ?? 0) < latestEndOffset;
          registerOutputConsumer(args);
          return {
            latestEndOffset,
            snapshotRequired,
          };
        }
      case "session_output_unsubscribe":
        unregisterOutputConsumer(args);
        return null;
      case "session_output_ack":
        return null;
      case "session_screen_snapshot_and_resume":
        {
          const resumedSnapshot = snapshot(args?.id);
          const consumers = terminalSnapshotResumes.get(args?.id) ?? new Map();
          consumers.set(args?.consumerId, resumedSnapshot.endOffset);
          terminalSnapshotResumes.set(args?.id, consumers);
          for (const probe of terminalRenderProbes.values()) {
            if (
              probe.id === args?.id &&
              probe.expectedEndOffset <= resumedSnapshot.endOffset
            ) {
              probe.resumed = true;
              probe.sawHydrating = probe.host.classList.contains(
                "terminal-hydrating",
              );
              if (!probe.sawHydrating) {
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    if (
                      terminalRenderProbes.get(probe.token) === probe &&
                      !probe.host.classList.contains("terminal-hydrating")
                    ) {
                      probe.retainedPainted = true;
                    }
                  }),
                );
              }
            }
          }
          return {
            snapshot: resumedSnapshot,
            state: {
              latestEndOffset: resumedSnapshot.endOffset,
              snapshotRequired: false,
            },
          };
        }
      case "plugin:event|listen": {
        const listeners = eventListeners.get(args?.event) ?? new Set();
        listeners.add(args?.handler);
        eventListeners.set(args?.event, listeners);
        return args?.handler;
      }
      case "plugin:event|unlisten": {
        const listeners = eventListeners.get(args?.event);
        listeners?.delete(args?.eventId);
        if (listeners?.size === 0) eventListeners.delete(args.event);
        callbacks.delete(args?.eventId);
        return null;
      }
      case "pty_list":
      case "list_conversations":
      case "scan_worktrees":
        return [];
      case "worktree_command": {
        const worktree = headlessSpawnFixture?.worktree;
        if (
          !worktree ||
          args?.repo !== worktree.repo ||
          args?.name !== worktree.name ||
          args?.from !== null ||
          headlessSpawnWorktreeCommands.length !== 0
        ) {
          throw new Error("media worktree planning call does not match its fixture");
        }
        const command =
          `git -C '${worktree.repo}' worktree add '${worktree.path}' ` +
          `-b '${worktree.branch}'`;
        const planned = {
          branch: worktree.branch,
          command,
          name: worktree.name,
          path: worktree.path,
          repo: worktree.repo,
        };
        headlessSpawnWorktreeCommands.push(planned);
        return [command, worktree.path, worktree.branch];
      }
      case "list_dir": {
        const worktree = headlessSpawnFixture?.worktree;
        if (
          worktree?.path === args?.path &&
          worktree.preExisting === false &&
          headlessSpawnWorktreeCreations.length === 0
        ) {
          throw new Error(`No such file or directory: ${worktree.path}`);
        }
        return [];
      }
      case "create_worktree": {
        const worktree = headlessSpawnFixture?.worktree;
        if (
          !worktree ||
          args?.repo !== worktree.repo ||
          args?.name !== worktree.name ||
          args?.from !== null ||
          headlessSpawnWorktreeCreations.length >= 2 ||
          headlessSpawnWorktreeCommands.length !== 1
        ) {
          throw new Error("media worktree creation call does not match its plan");
        }
        const created = {
          branch: worktree.branch,
          invocation: headlessSpawnWorktreeCreations.length + 1,
          name: worktree.name,
          outcome:
            headlessSpawnWorktreeCreations.length === 0 ? "created" : "reused",
          path: worktree.path,
          repo: worktree.repo,
        };
        headlessSpawnWorktreeCreations.push(created);
        return { branch: created.branch, path: created.path };
      }
      case "hmux_inspect_sessions_exact":
        return (args?.targets ?? []).map((target) => {
          const session = hmuxSessions.get(target.sessionId);
          return session?.workspaceId === target.workspaceId
            ? { outcome: "found", session }
            : { outcome: "not_found", ...target };
        });
      case "hmux_list_sessions":
        return [...hmuxSessions.values()];
      case "hmux_probe_sessions":
        return (args?.sessionIds ?? []).flatMap((sessionId) => {
          const session = hmuxSessions.get(sessionId);
          return session ? [session] : [];
        });
      case "hmux_plan_recovery": {
        const request = args?.request ?? {};
        if (
          !recoveryFixture ||
          request.sessionId !== recoveryFixture.source.sessionId ||
          request.workspaceId !== recoveryFixture.source.workspaceId
        ) {
          throw new Error("media fixture has no recovery plan for this session");
        }
        if (recoveryStage() !== "stale") {
          return {
            sessionId: request.sessionId,
            sourceBuildId: recoveryFixture.source.hostBuildVersion,
            targetBuildId: recoveryFixture.replacement.hostBuildVersion,
            action: "none",
            allowed: false,
            reason: "recovery_source_healthy",
            requiresConfirmation: false,
          };
        }
        return {
          sessionId: request.sessionId,
          sourceBuildId: recoveryFixture.source.hostBuildVersion,
          targetBuildId: recoveryFixture.replacement.hostBuildVersion,
          action: recoveryFixture.requiresConfirmation
            ? "none"
            : "restore_plain_shell_with_current_build",
          allowed: !recoveryFixture.requiresConfirmation,
          reason: recoveryFixture.requiresConfirmation
            ? "update_requires_confirmation"
            : undefined,
          requiresConfirmation: Boolean(recoveryFixture.requiresConfirmation),
        };
      }
      case "hmux_execute_recovery": {
        const request = args?.request ?? {};
        if (
          !recoveryFixture ||
          request.sessionId !== recoveryFixture.source.sessionId ||
          request.workspaceId !== recoveryFixture.source.workspaceId ||
          request.kind !== "plain_shell"
        ) {
          throw new Error("media fixture has no recovery execution for this session");
        }
        if (recoveryStage() === "restored") {
          return {
            sourceSessionId: recoveryFixture.source.sessionId,
            targetBuildId: recoveryFixture.replacement.hostBuildVersion,
            action: "restore_plain_shell_with_current_build",
            outcome: "restored",
            replayed: true,
            replacementSession: recoveryReplacementSummary(),
          };
        }
        if (recoveryFixture.requiresConfirmation && request.confirmed !== true) {
          return {
            sourceSessionId: recoveryFixture.source.sessionId,
            targetBuildId: recoveryFixture.replacement.hostBuildVersion,
            action: "none",
            outcome: "refused",
            replayed: false,
            reason: "update_requires_confirmation",
          };
        }
        window.sessionStorage?.setItem?.(recoveryStageKey, "restored");
        synchronizeRecoverySessions();
        bindTerminalHost(recoveryFixture.replacement.sessionId);
        return {
          sourceSessionId: recoveryFixture.source.sessionId,
          targetBuildId: recoveryFixture.replacement.hostBuildVersion,
          action: "restore_plain_shell_with_current_build",
          outcome: "restored",
          replayed: false,
          replacementSession: recoveryReplacementSummary(),
        };
      }
      case "hmux_managed_create":
      case "hmux_managed_shell_create":
        return managedCreateReceipt(args);
      case "hmux_managed_create_advance_v1": {
        const request = args?.request ?? {};
        return {
          state: "current",
          receipt: managedCreateReceipt(request),
        };
      }
      case "hmux_initial_agent_prompt":
        return initialAgentPromptReceipt(args?.request);
      case "hmux_structured_terminal_attach":
        return attachStructuredTerminal(args);
      case "hmux_structured_terminal_next":
        return nextStructuredTerminalRecord(args?.observerId);
      case "hmux_structured_terminal_detach":
        detachStructuredTerminal(args?.observerId);
        return null;
      case "hmux_structured_terminal_upstream":
        return handleStructuredTerminalUpstream(args);
      case "git_status":
        return gitStatus(args?.path);
      case "agent_diff_stat":
        return diffStat(args?.path);
      case "diff_review_target_create": {
        const { agent, review } = diffReview(args?.path);
        const target = {
          reviewId: args.reviewId,
          worktreePath: agent.worktreePath,
          worktreeGitDir: `/workspace/dure/.git/worktrees/${agent.name}`,
          baseRef: review.baseRef,
          baseCommitSha: review.mergeBase,
          headCommitSha: review.headCommitSha,
          sourceSessionId: args.sourceSessionId ?? null,
          feedbackAgentId: args.feedbackAgentId ?? null,
          createdAtMs: Date.now(),
        };
        reviewTargets.set(args.reviewId, { review, target });
        return target;
      }
      case "diff_review_snapshot": {
        const entry = reviewTargets.get(args?.reviewId);
        if (!entry) {
          throw new Error(`media fixture has no review target ${args?.reviewId}`);
        }
        return {
          target: entry.target,
          review: {
            baseRef: entry.review.baseRef,
            mergeBase: entry.review.mergeBase,
            files: entry.review.files,
            worktreePath: entry.target.worktreePath,
            diff: entry.review.diff,
          },
        };
      }
      case "diff_review_targets_reconcile":
        return {
          activeTargets: args?.activeReviewIds?.length ?? 0,
          inactiveTargets: 0,
          deletedTargets: 0,
        };
      case "read_file": {
        const path = args?.path ?? "/workspace/dure/src/sessionRecovery.ts";
        const content = [
          "export function restoreWorkspace(snapshot: WorkspaceSnapshot) {",
          "  const liveSessions = reconcileSessions(snapshot.sessions);",
          "  return { ...snapshot, sessions: liveSessions };",
          "}",
          "",
          "export const recoveryPolicy = {",
          '  reconnect: "without-provider-replay",',
          '  stalePane: "retain-until-confirmed",',
          "};",
        ].join("\n");
        return {
          name: path.split("/").pop(),
          path,
          kind: "text",
          content,
        };
      }
      case "plugin:window|is_fullscreen":
        return Boolean(config.windowChrome?.fullscreen);
      case "plugin:dialog|message":
        return recoveryFixture ? "Ok" : null;
      case "append_hmux_connection_diagnostics":
        hmuxConnectionDiagnostics.push(...(args?.events ?? []));
        return null;
      case "ssh_connection_state":
        return { state: "connected", message: null };
      case "remote_hmux_known_host_fingerprints":
        return ["SHA256:mediafixturehostkey1234567890"];
      case "remote_hmux_managed_create": {
        const request = args?.request ?? {};
        if (request.sessionId) {
          terminalCwds.set(request.sessionId, request.cwd ?? "");
          bindTerminalHost(request.sessionId);
        }
        return {
          idempotencyKey: request.idempotencyKey,
          bridgeNonce: request.bridgeNonce,
          outcome: "created",
          session: remoteHmuxSession(request),
        };
      }
      case "remote_hmux_catalog":
        for (const agent of fixture.agents ?? []) {
          const binding = agent.runtimeBinding;
          if (binding?.source !== "ssh") continue;
          remoteHmuxSession({
            providerId: agent.provider,
            sessionClass:
              binding.runtime === "hmux_managed_v1"
                ? "managed"
                : "standalone",
            sessionId: binding.sessionId,
            workspaceId: binding.workspaceId,
          });
        }
        return {
          schemaVersion: 1,
          hostId: args?.request?.hostId ?? "host-studio",
          sessions: [...remoteHmuxSessions.values()],
        };
      case "remote_hmux_structured_terminal_attach":
        return attachRemoteStructuredTerminal(args?.request);
      case "remote_hmux_initial_agent_prompt":
        return initialAgentPromptReceipt(args?.request);
      case "remote_hmux_pane_depart_gracefully":
        return { state: "session_preserved", reason: "not_attached" };
      case "list_provider_conversations":
        return (fixture.providerConversations ?? []).filter(
          (record) => record.executionLocation === "local",
        );
      case "list_remote_provider_conversations":
        return (fixture.providerConversations ?? []).filter(
          (record) =>
            record.executionLocation === "ssh" &&
            record.hostId === args?.hostId,
        );
      case "provider_conversation_details":
      case "remote_provider_conversation_details": {
        const executionLocation =
          command === "remote_provider_conversation_details" ? "ssh" : "local";
        const match = (fixture.providerConversationDetails ?? []).find(
          (details) =>
            details.provider === args?.provider &&
            details.conversationId === args?.conversationId &&
            details.executionLocation === executionLocation &&
            (executionLocation === "local" || details.hostId === args?.hostId),
        );
        return match
          ? {
              subagents: (match.subagents ?? []).map((subagent) => ({
                ...subagent,
              })),
              totalCount: match.totalCount ?? match.subagents?.length ?? 0,
            }
          : { subagents: [], totalCount: 0 };
      }
      case "ssh_exec_once":
        return { stdout: "true\n", stderr: "", code: 0 };
      case "ssh_write":
        recordTerminalWrite(args?.id, args?.data);
        return null;
      default:
        return null;
    }
  }

  window.__DURE_MEDIA_CAPTURE_MOCK__ = {
    advanceOrchestrationChannel({ desktopId, phaseId, terminalSessionId }) {
      if (!orchestrationChannelFixture) {
        throw new Error("media fixture has no orchestration channel contract");
      }
      const expected =
        orchestrationChannelFixture.phases[orchestrationChannelAdvances.length];
      if (
        expected?.id !== phaseId ||
        desktopId !== orchestrationChannelFixture.desktopId ||
        !terminalSessionId ||
        (orchestrationTerminalSessionId &&
          orchestrationTerminalSessionId !== terminalSessionId)
      ) {
        throw new Error("orchestration channel phases must advance exactly once in order");
      }
      orchestrationTerminalSessionId = terminalSessionId;
      const advance = {
        agentBindings: structuredClone(orchestrationChannelFixture.agentBindings),
        agentComments: structuredClone(expected.agentComments),
        desktopId,
        gateStatus: expected.gateStatus,
        messageIds: [...expected.messageIds],
        phaseId,
        taskStates: structuredClone(expected.taskStates),
        terminalSessionId,
      };
      orchestrationChannelAdvances.push(advance);
      terminalSnapshots[terminalSessionId] = orchestrationTerminalScreen(expected);
      return structuredClone(advance);
    },
    completeOrchestrationChannel(presentation) {
      const expected = orchestrationChannelAdvances.at(-1);
      if (
        !expected ||
        orchestrationChannelPresentations.length !==
          orchestrationChannelAdvances.length - 1 ||
        presentation?.phaseId !== expected.phaseId ||
        presentation.desktopId !== expected.desktopId ||
        presentation.terminalSessionId !== expected.terminalSessionId ||
        JSON.stringify(presentation.agentPanels) !==
          JSON.stringify(expected.agentBindings) ||
        JSON.stringify(presentation.messageIds) !==
          JSON.stringify(expected.messageIds) ||
        JSON.stringify(presentation.taskStates) !==
          JSON.stringify(expected.taskStates) ||
        presentation.gateStatus !== expected.gateStatus
      ) {
        throw new Error("orchestration presentation does not join its channel phase");
      }
      const completed = structuredClone(presentation);
      orchestrationChannelPresentations.push(completed);
      return completed;
    },
    beginHeadlessSpawn({ desktopId, terminalSessionId }) {
      if (!headlessSpawnFixture) {
        throw new Error("media fixture has no headless spawn contract");
      }
      if (
        desktopId !== headlessSpawnFixture.desktopId ||
        !terminalSessionId ||
        headlessSpawnRequests.length !== 0
      ) {
        throw new Error("headless spawn must be dispatched exactly once");
      }
      headlessSpawnTerminalSessionId = terminalSessionId;
      const params = {
        ...structuredClone(headlessSpawnFixture.request),
        receiptId: headlessSpawnFixture.receiptId,
        placement: {
          referenceSessionId: terminalSessionId,
          direction: "right",
        },
      };
      const receipt = initialHeadlessSpawnReceipt(params);
      headlessSpawnReceipts.set(receipt.receiptId, receipt);
      const accepted = {
        status: 202,
        body: { ok: true, receiptId: receipt.receiptId },
        terminalSessionId,
      };
      headlessSpawnRequests.push({
        desktopId,
        params: structuredClone(params),
        receiptId: receipt.receiptId,
        status: accepted.status,
      });
      terminalSnapshots[terminalSessionId] = headlessSpawnTerminalScreen(receipt);
      dispatchEvent("cli:request", {
        reqId: receipt.receiptId,
        action: "spawn.v2",
        params,
      });
      return structuredClone(accepted);
    },
    completeHeadlessSpawn(presentation) {
      if (!headlessSpawnFixture || headlessSpawnPresentations.length !== 0) {
        throw new Error("headless spawn presentation must complete exactly once");
      }
      const receipt = headlessSpawnReceipts.get(presentation?.receiptId);
      const pane = receipt?.steps.find(({ step }) => step === "pane");
      const runtime = receipt?.steps.find(
        ({ step }) => step === "runtime_session",
      );
      const worktree = receipt?.steps.find(({ step }) => step === "worktree");
      const agentArtifacts =
        pane?.artifacts?.filter(({ kind }) => kind === "agent_registration") ?? [];
      const paneArtifacts =
        pane?.artifacts?.filter(({ kind }) => kind === "pane") ?? [];
      const worktreeArtifacts =
        worktree?.artifacts?.filter(({ kind }) => kind === "worktree") ?? [];
      const [agentArtifact] = agentArtifacts;
      const [paneArtifact] = paneArtifacts;
      const [worktreeArtifact] = worktreeArtifacts;
      const worktreeContract = headlessSpawnFixture.worktree;
      const worktreeJoined = worktreeContract
        ? worktree?.status === "ok" &&
          worktreeArtifacts.length === 1 &&
          worktreeArtifact?.ownership === "created_by_request" &&
          worktreeArtifact?.id === worktreeContract.path &&
          worktreeArtifact?.branch === worktreeContract.branch &&
          headlessSpawnWorktreeCommands.length === 1 &&
          headlessSpawnWorktreeCreations.length === 2 &&
          headlessSpawnWorktreeCreations[0]?.outcome === "created" &&
          headlessSpawnWorktreeCreations[1]?.outcome === "reused" &&
          headlessSpawnWorktreeStatusReads.length > 0 &&
          presentation.worktreePath === worktreeContract.path &&
          presentation.branch === worktreeContract.branch &&
          JSON.stringify(presentation.gitStatus) ===
            JSON.stringify(worktreeContract.gitStatus)
        : worktree?.status === "skipped" &&
          worktreeArtifacts.length === 0 &&
          headlessSpawnWorktreeCommands.length === 0 &&
          headlessSpawnWorktreeCreations.length === 0;
      if (
        receipt?.state !== "succeeded" ||
        !worktreeJoined ||
        pane?.status !== "ok" ||
        runtime?.status !== "ok" ||
        agentArtifacts.length !== 1 ||
        paneArtifacts.length !== 1 ||
        presentation.desktopId !== headlessSpawnFixture.desktopId ||
        presentation.terminalSessionId !== headlessSpawnTerminalSessionId ||
        presentation.sessionId !== headlessSpawnRuntimeSessionId ||
        presentation.sessionId !== runtime.detail?.sessionId ||
        presentation.agentId !== agentArtifact?.id ||
        presentation.panelId !== paneArtifact?.id ||
        presentation.panelId !== `agent:${presentation.agentId}`
      ) {
        throw new Error("headless spawn presentation does not join its receipt");
      }
      headlessSpawnPresentations.push(structuredClone(presentation));
      terminalSnapshots[presentation.terminalSessionId] =
        headlessSpawnTerminalScreen(receipt, true);
      return structuredClone(presentation);
    },
    resolveTerminalSessionId(id) {
      if (id === "tour-session-new" && productTourRuntimeSessionId) return productTourRuntimeSessionId;
      return headlessSpawnFixture?.providerTarget?.sessionId === id &&
        headlessSpawnRuntimeSessionId
        ? headlessSpawnRuntimeSessionId
        : id;
    },
    terminalConsumerCount(id) {
      if (hmuxSessions.has(id) || remoteHmuxSessions.has(id)) {
        return [...hmuxClientSessions.values()].filter(
          (sessionId) => sessionId === id,
        ).length;
      }
      return outputConsumers.get(id)?.size ?? 0;
    },
    registerTerminalCwd(id, cwd) {
      if (id) terminalCwds.set(id, cwd ?? "");
    },
    publishTerminalSnapshot({
      kind = "pty",
      id,
      repaintBase64,
      columns,
      rows,
    }) {
      if (!id || typeof repaintBase64 !== "string") {
        throw new Error("live terminal snapshot requires id and repaintBase64");
      }
      let content = new TextDecoder().decode(
        Uint8Array.from(atob(repaintBase64), (byte) => byte.charCodeAt(0)),
      );
      const pastedInput = clipboardImagePasteWrites.findLast(
        (write) => write.sessionId === id,
      )?.data;
      if (pastedInput && !content.includes(pastedInput.trim())) {
        content = `${content}${pastedInput}`;
      }
      terminalSnapshots[id] = content;
      if (Number.isFinite(columns) && Number.isFinite(rows)) {
        terminalSnapshotGeometry.set(id, { columns, rows });
        fixedTerminalSnapshotGeometry.add(id);
      }
      const previousOffset = terminalSnapshotOffsets.get(id) ?? 0;
      const endOffset =
        previousOffset +
        Math.max(1, new TextEncoder().encode(content).length);
      terminalSnapshotOffsets.set(id, endOffset);
      for (const probe of terminalRenderProbes.values()) {
        if (probe.id === id) probe.expectedEndOffset = endOffset;
      }
      for (const consumerId of outputConsumers.get(id) ?? []) {
        dispatchEvent("session:snapshot-required", {
          kind,
          id,
          consumerId,
          endOffset,
        });
      }
      return {
        consumerIds: [...(outputConsumers.get(id) ?? [])],
        consumers: outputConsumers.get(id)?.size ?? 0,
        endOffset,
        sourceGeometry: terminalSnapshotGeometry.get(id) ?? null,
        viewportGeometry: terminalViewportGeometry.get(id) ?? null,
      };
    },
    publishLiveTerminalSnapshot(snapshot) {
      const publication =
        window.__DURE_MEDIA_CAPTURE_MOCK__.publishTerminalSnapshot(snapshot);
      if (!hmuxSessions.has(snapshot.id) && !remoteHmuxSessions.has(snapshot.id)) {
        return { ...publication, transport: "session" };
      }
      const repaint =
        window.__DURE_MEDIA_CAPTURE_MOCK__.repaintHmuxTerminal(snapshot.id);
      return {
        ...publication,
        consumerIds: repaint.observerIds,
        consumers: repaint.observerIds.length,
        transport: "hmux",
      };
    },
    beginTerminalRenderProbe(id) {
      const host = [...document.querySelectorAll("[data-dure-media-session-id]")]
        .find((element) => element.dataset.dureMediaSessionId === id);
      if (!host) throw new Error(`terminal ${id} has no bound render host`);
      const token = `${id}:${Date.now()}:${Math.random()}`;
      const probe = {
        id,
        host,
        token,
        observer: null,
        initialProjectionRevision:
          host.querySelector(terminalSurfaceSelectors.paintedViewport)?.dataset
            .projectionRevision ?? null,
        expectedEndOffset: Number.POSITIVE_INFINITY,
        resumed: false,
        retainedPainted: false,
        sawHydrating: false,
        rendered: false,
      };
      probe.observer = new MutationObserver(() => {
        if (!probe.resumed) return;
        if (host.classList.contains("terminal-hydrating")) {
          probe.sawHydrating = true;
          return;
        }
        const revision = host.querySelector(
          terminalSurfaceSelectors.paintedViewport,
        )?.dataset.projectionRevision;
        if (
          probe.sawHydrating ||
          (revision && revision !== probe.initialProjectionRevision)
        ) {
          probe.rendered = true;
        }
      });
      probe.observer.observe(host, {
        attributes: true,
        attributeFilter: ["class", "data-projection-revision"],
        childList: true,
        subtree: true,
      });
      terminalRenderProbes.set(token, probe);
      return token;
    },
    cancelTerminalRenderProbe(token) {
      const probe = terminalRenderProbes.get(token);
      probe?.observer?.disconnect();
      terminalRenderProbes.delete(token);
    },
    repaintTerminal(id, kind = "pty") {
      if (hmuxSessions.has(id) || remoteHmuxSessions.has(id)) {
        return window.__DURE_MEDIA_CAPTURE_MOCK__.repaintHmuxTerminal(id);
      }
      const repaint = snapshot(id);
      const geometry =
        terminalSnapshotGeometry.get(id) ?? defaultTerminalSnapshotGeometry;
      return window.__DURE_MEDIA_CAPTURE_MOCK__.publishTerminalSnapshot({
        kind,
        id,
        repaintBase64: repaint.data,
        columns: geometry.columns,
        rows: geometry.rows,
      });
    },
    repaintHmuxTerminal(id) {
      const current = hmuxSessions.get(id);
      const remote = remoteHmuxSessions.get(id);
      const session = current ?? remote;
      const terminalEpoch = session?.terminalEpoch;
      if (!terminalEpoch) {
        throw new Error(`managed terminal ${id} is not registered`);
      }
      const sequenceThrough = String(
        BigInt(sessionOutputSequence(session)) + 1n,
      );
      if (current) current.outputSeq = sequenceThrough;
      else remoteHmuxOutputSequences.set(id, sequenceThrough);
      snapshot(id);
      const geometry =
        terminalSnapshotGeometry.get(id) ?? defaultTerminalSnapshotGeometry;
      const observerIds = [...hmuxClientSessions]
        .filter(([, sessionId]) => sessionId === id)
        .map(([clientId]) => clientId);
      const structuredObserverIds = observerIds.filter((observerId) =>
        structuredTerminalRecords.has(observerId),
      );
      const currentProjectionRevision =
        structuredTerminalProjectionRevisions.get(id) ?? 0n;
      const projectionRevision =
        currentProjectionRevision >= BigInt(sequenceThrough)
          ? currentProjectionRevision + 1n
          : BigInt(sequenceThrough);
      const structuredViewport =
        structuredObserverIds.length > 0
          ? encodeStructuredTerminalViewport(session, {
              geometry,
              projectionRevision,
            })
          : null;
      for (const observerId of observerIds) {
        if (structuredViewport && structuredTerminalRecords.has(observerId)) {
          enqueueStructuredTerminalRecord(
            observerId,
            structuredViewport,
          );
        }
      }
      for (const probe of terminalRenderProbes.values()) {
        if (probe.id !== id) continue;
        probe.resumed = true;
        probe.expectedEndOffset = terminalSnapshotOffsets.get(id) ?? 0;
        probe.sawHydrating = probe.host.classList.contains(
          "terminal-hydrating",
        );
        if (!probe.sawHydrating) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (
                terminalRenderProbes.get(probe.token) === probe &&
                !probe.host.classList.contains("terminal-hydrating")
              ) {
                probe.retainedPainted = true;
              }
            }),
          );
        }
      }
      return { observerIds, terminalEpoch, sequenceThrough };
    },
    async waitForTerminalSnapshotResume({
      id,
      endOffset,
      consumerIds,
      renderProbe,
      timeoutMs = 2_000,
    }) {
      const expected = new Set(consumerIds ?? []);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const resumed = terminalSnapshotResumes.get(id) ?? new Map();
        const resumedConsumers = [...expected].filter(
          (consumerId) => (resumed.get(consumerId) ?? 0) >= endOffset,
        );
        if (resumedConsumers.length > 0) {
          const probe = renderProbe
            ? terminalRenderProbes.get(renderProbe)
            : null;
          if (
            renderProbe &&
            (!probe?.resumed || probe.expectedEndOffset !== endOffset)
          ) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
            continue;
          }
          return { resumedConsumers, endOffset };
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      throw new Error(`terminal ${id} did not resume snapshot ${endOffset}`);
    },
    async waitForTerminalRender(token, timeoutMs = 2_000) {
      const probe = terminalRenderProbes.get(token);
      if (!probe) throw new Error(`terminal render probe is missing: ${token}`);
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          if (probe.rendered) return { rendered: true };
          if (
            probe.resumed &&
            !probe.sawHydrating &&
            probe.retainedPainted &&
            !probe.host.classList.contains("terminal-hydrating")
          ) {
            const viewport = probe.host.querySelector(
              terminalSurfaceSelectors.paintedViewport,
            );
            const bounds = viewport?.getBoundingClientRect();
            if (
              viewport?.textContent?.trim() &&
              bounds &&
              bounds.width > 0 &&
              bounds.height > 0
            ) {
              return { rendered: true, retained: true };
            }
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        throw new Error(
          "terminal snapshot did not complete its structured render cycle",
        );
      } finally {
        probe.observer?.disconnect();
        terminalRenderProbes.delete(token);
      }
    },
    diagnostics() {
      return {
        eventListeners: Object.fromEntries(
          [...eventListeners].map(([event, listeners]) => [event, listeners.size]),
        ),
        outputConsumers: Object.fromEntries(
          [...outputConsumers].map(([id, consumers]) => [id, consumers.size]),
        ),
        terminalSnapshotOffsets: Object.fromEntries(terminalSnapshotOffsets),
        terminalSnapshotGeometry: Object.fromEntries(terminalSnapshotGeometry),
        terminalViewportGeometry: Object.fromEntries(terminalViewportGeometry),
        terminalSnapshotResumes: Object.fromEntries(
          [...terminalSnapshotResumes].map(([id, consumers]) => [
            id,
            Object.fromEntries(consumers),
          ]),
        ),
        pendingRenderProbes: terminalRenderProbes.size,
        nativeWindowBridge: nativeWindowBridge?.diagnostics() ?? null,
        recoveryStage: recoveryStage(),
        commandCounts: Object.fromEntries(commandCounts),
        terminalCwds: Object.fromEntries(terminalCwds),
        hmuxClientSessions: Object.fromEntries(hmuxClientSessions),
        hmuxConnectionDiagnostics: [...hmuxConnectionDiagnostics],
        clipboardImagePaste: {
          uploads: [...clipboardImagePasteUploads],
          writes: [...clipboardImagePasteWrites],
        },
        headlessSpawn: headlessSpawnFixture
          ? {
              presentations: structuredClone(headlessSpawnPresentations),
              requests: structuredClone(headlessSpawnRequests),
              receipts: Object.fromEntries(
                [...headlessSpawnReceipts].map(([id, receipt]) => [
                  id,
                  structuredClone(receipt),
                ]),
              ),
              runtimeSessionId: headlessSpawnRuntimeSessionId,
              worktreeCommands: structuredClone(headlessSpawnWorktreeCommands),
              worktreeCreations: structuredClone(
                headlessSpawnWorktreeCreations,
              ),
              worktreeStatusReads: structuredClone(
                headlessSpawnWorktreeStatusReads,
              ),
            }
          : null,
        orchestrationChannel: orchestrationChannelFixture
          ? {
              contract: {
                agentBindings: structuredClone(
                  orchestrationChannelFixture.agentBindings,
                ),
                desktopId: orchestrationChannelFixture.desktopId,
                gateId: orchestrationChannelFixture.gate.id,
                messageIds: orchestrationChannelFixture.messages.map(({ id }) => id),
                messages: orchestrationChannelFixture.messages.map(
                  ({ from, id, taskId, to, type }) => ({
                    from,
                    id,
                    taskId,
                    to,
                    type,
                  }),
                ),
                phaseIds: orchestrationChannelFixture.phases.map(({ id }) => id),
                phases: orchestrationChannelFixture.phases.map((phase) => ({
                  gateStatus: phase.gateStatus,
                  id: phase.id,
                  messageIds: [...phase.messageIds],
                  taskStates: structuredClone(phase.taskStates),
                })),
                taskIds: orchestrationChannelFixture.tasks.map(({ id }) => id),
              },
              advances: structuredClone(orchestrationChannelAdvances),
              presentations: structuredClone(
                orchestrationChannelPresentations,
              ),
            }
          : null,
      };
    },
  };
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: config.windowLabel ?? "main" },
      currentWebview: {
        windowLabel: config.windowLabel ?? "main",
        label: config.windowLabel ?? "main",
      },
    },
    transformCallback(callback, once) {
      const id = ++callbackId;
      callbacks.set(id, { callback, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(path) {
      return path;
    },
    invoke(command, args) {
      try {
        commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);
        return Promise.resolve(result(command, args));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, eventId) {
      const listeners = eventListeners.get(event);
      listeners?.delete(eventId);
      if (listeners?.size === 0) eventListeners.delete(event);
      callbacks.delete(eventId);
    },
  };
  window.__TAURI__ = window.__TAURI__ || {};
})();
