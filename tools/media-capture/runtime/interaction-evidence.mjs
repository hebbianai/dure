const CAPTURE_FORMATS = Object.freeze(["png", "webm"]);

function completedClipboardImagePaste(receipt) {
  if (receipt === undefined) return null;
  if (!Array.isArray(receipt?.uploads) || !Array.isArray(receipt?.writes)) {
    throw new Error("clipboard image paste receipt has an invalid shape");
  }
  if (receipt.uploads.length === 0 && receipt.writes.length === 0) return null;
  if (receipt.uploads.length !== 1 || receipt.writes.length !== 1) {
    throw new Error("clipboard image paste receipt must be exactly-once");
  }
  const [upload] = receipt.uploads;
  const [write] = receipt.writes;
  if (
    upload.sessionId !== write.sessionId ||
    write.data !== `${upload.remotePath} `
  ) {
    throw new Error("clipboard image paste receipt does not join upload to write");
  }
  return { upload, write };
}

function completedHeadlessSpawn(diagnostics) {
  if (diagnostics === undefined || diagnostics === null) return null;
  if (
    !Array.isArray(diagnostics.requests) ||
    !Array.isArray(diagnostics.presentations) ||
    !Array.isArray(diagnostics.worktreeCommands) ||
    !Array.isArray(diagnostics.worktreeCreations) ||
    !Array.isArray(diagnostics.worktreeStatusReads) ||
    typeof diagnostics.receipts !== "object" ||
    diagnostics.receipts === null
  ) {
    throw new Error("headless spawn evidence has an invalid shape");
  }
  if (
    diagnostics.requests.length === 0 &&
    diagnostics.presentations.length === 0 &&
    Object.keys(diagnostics.receipts).length === 0
  ) {
    return null;
  }
  if (
    diagnostics.requests.length !== 1 ||
    diagnostics.presentations.length !== 1 ||
    Object.keys(diagnostics.receipts).length !== 1
  ) {
    throw new Error("headless spawn evidence must be exactly-once");
  }
  const [request] = diagnostics.requests;
  const [presentation] = diagnostics.presentations;
  const receipt = diagnostics.receipts[request.receiptId];
  const pane = receipt?.steps?.find(({ step }) => step === "pane");
  const runtime = receipt?.steps?.find(
    ({ step }) => step === "runtime_session",
  );
  const worktree = receipt?.steps?.find(({ step }) => step === "worktree");
  const agentArtifacts =
    pane?.artifacts?.filter(({ kind }) => kind === "agent_registration") ?? [];
  const paneArtifacts =
    pane?.artifacts?.filter(({ kind }) => kind === "pane") ?? [];
  const [agentArtifact] = agentArtifacts;
  const [paneArtifact] = paneArtifacts;
  const worktreeArtifacts =
    worktree?.artifacts?.filter(({ kind }) => kind === "worktree") ?? [];
  const [worktreeArtifact] = worktreeArtifacts;
  const usesWorktree = receipt?.request?.useWorktree === true;
  const [worktreeCommand] = diagnostics.worktreeCommands;
  const [worktreeCreation, worktreeReuse] = diagnostics.worktreeCreations;
  const worktreeJoined = usesWorktree
    ? worktree?.status === "ok" &&
      worktreeArtifacts.length === 1 &&
      worktreeArtifact?.ownership === "created_by_request" &&
      diagnostics.worktreeCommands.length === 1 &&
      diagnostics.worktreeCreations.length === 2 &&
      worktreeCreation?.outcome === "created" &&
      worktreeReuse?.outcome === "reused" &&
      diagnostics.worktreeStatusReads.length > 0 &&
      worktreeCommand?.repo === worktreeCreation?.repo &&
      worktreeCommand?.name === worktreeCreation?.name &&
      worktreeCommand?.path === worktreeCreation?.path &&
      worktreeCommand?.branch === worktreeCreation?.branch &&
      worktreeReuse?.repo === worktreeCreation?.repo &&
      worktreeReuse?.name === worktreeCreation?.name &&
      worktreeReuse?.path === worktreeCreation?.path &&
      worktreeReuse?.branch === worktreeCreation?.branch &&
      worktreeArtifact?.id === worktreeCreation?.path &&
      worktreeArtifact?.branch === worktreeCreation?.branch &&
      worktree?.detail?.path === worktreeCreation?.path &&
      worktree?.detail?.branch === worktreeCreation?.branch &&
      presentation.worktreePath === worktreeCreation?.path &&
      presentation.branch === worktreeCreation?.branch &&
      diagnostics.worktreeStatusReads.every(
        ({ path, status }) =>
          path === worktreeCreation.path &&
          status?.branch === worktreeCreation.branch &&
          JSON.stringify(status) === JSON.stringify(presentation.gitStatus),
      )
    : worktree?.status === "skipped" &&
      worktreeArtifacts.length === 0 &&
      diagnostics.worktreeCommands.length === 0 &&
      diagnostics.worktreeCreations.length === 0 &&
      diagnostics.worktreeStatusReads.length === 0;
  const completedSteps = receipt?.steps
    ?.filter(({ status }) => status === "ok" || status === "skipped")
    .map(({ status, step }) => ({ status, step }));
  if (
    request.status !== 202 ||
    receipt?.receiptId !== request.receiptId ||
    receipt?.state !== "succeeded" ||
    !worktreeJoined ||
    pane?.status !== "ok" ||
    runtime?.status !== "ok" ||
    presentation.receiptId !== receipt.receiptId ||
    agentArtifacts.length !== 1 ||
    paneArtifacts.length !== 1 ||
    presentation.agentId !== agentArtifact?.id ||
    presentation.panelId !== paneArtifact?.id ||
    presentation.panelId !== `agent:${presentation.agentId}` ||
    presentation.sessionId !== runtime.detail?.sessionId ||
    presentation.sessionId !== diagnostics.runtimeSessionId ||
    JSON.stringify(completedSteps) !==
      JSON.stringify([
        { status: "ok", step: "preflight" },
        { status: usesWorktree ? "ok" : "skipped", step: "worktree" },
        { status: "ok", step: "pane" },
        { status: "ok", step: "runtime_session" },
        { status: "ok", step: "provider_exec" },
        { status: "skipped", step: "prompt_delivery" },
      ])
  ) {
    throw new Error("headless spawn evidence does not join request to pane");
  }
  return {
    agentId: presentation.agentId,
    panelId: presentation.panelId,
    receiptId: receipt.receiptId,
    sessionId: presentation.sessionId,
    state: receipt.state,
    steps: completedSteps,
    ...(usesWorktree
      ? {
          worktree: {
            branch: worktreeCreation.branch,
            gitStatus: presentation.gitStatus,
            ownership: worktreeArtifact.ownership,
            path: worktreeCreation.path,
          },
        }
      : {}),
  };
}

function completedOrchestrationChannel(diagnostics) {
  if (diagnostics === undefined || diagnostics === null) return null;
  if (
    !Array.isArray(diagnostics.advances) ||
    !Array.isArray(diagnostics.presentations) ||
    !Array.isArray(diagnostics.contract?.agentBindings) ||
    !Array.isArray(diagnostics.contract?.messageIds) ||
    !Array.isArray(diagnostics.contract?.messages) ||
    !Array.isArray(diagnostics.contract?.phaseIds) ||
    !Array.isArray(diagnostics.contract?.phases) ||
    !Array.isArray(diagnostics.contract?.taskIds)
  ) {
    throw new Error("orchestration channel evidence has an invalid shape");
  }
  const { advances, contract, presentations } = diagnostics;
  if (advances.length === 0 && presentations.length === 0) return null;
  if (
    advances.length !== contract.phases.length ||
    presentations.length !== contract.phases.length ||
    contract.phaseIds.length !== contract.phases.length ||
    new Set(contract.phaseIds).size !== contract.phaseIds.length ||
    new Set(contract.messageIds).size !== contract.messageIds.length ||
    new Set(contract.taskIds).size !== contract.taskIds.length
  ) {
    throw new Error("orchestration channel evidence must be exactly-once");
  }
  const terminalSessionIds = new Set();
  for (const [index, expected] of contract.phases.entries()) {
    const advance = advances[index];
    const presentation = presentations[index];
    const expectedPhaseId = contract.phaseIds[index];
    if (
      expected.id !== expectedPhaseId ||
      advance?.phaseId !== expectedPhaseId ||
      presentation?.phaseId !== expectedPhaseId ||
      advance.desktopId !== contract.desktopId ||
      presentation.desktopId !== contract.desktopId ||
      advance.terminalSessionId !== presentation.terminalSessionId ||
      JSON.stringify(advance.agentBindings) !==
        JSON.stringify(contract.agentBindings) ||
      JSON.stringify(presentation.agentPanels) !==
        JSON.stringify(contract.agentBindings) ||
      JSON.stringify(advance.messageIds) !== JSON.stringify(expected.messageIds) ||
      JSON.stringify(presentation.messageIds) !==
        JSON.stringify(expected.messageIds) ||
      JSON.stringify(advance.taskStates) !== JSON.stringify(expected.taskStates) ||
      JSON.stringify(presentation.taskStates) !==
        JSON.stringify(expected.taskStates) ||
      advance.gateStatus !== expected.gateStatus ||
      presentation.gateStatus !== expected.gateStatus
    ) {
      throw new Error("orchestration channel phase does not join its presentation");
    }
    terminalSessionIds.add(advance.terminalSessionId);
  }
  const finalPhase = contract.phases.at(-1);
  const decisionPhase = contract.phases.find(({ id }) => id === "decision");
  const types = [...new Set(contract.messages.map(({ type }) => type))];
  const requiredTypes = [
    "note",
    "dispatch",
    "heartbeat",
    "worker_done",
    "decision_gate",
  ];
  const bindingsByTask = new Map(
    contract.agentBindings.map((binding) => [binding.taskId, binding]),
  );
  const messageIds = contract.messages.map(({ id }) => id);
  const workerMessagesJoin = contract.messages.every((message) => {
    if (!message.taskId) return true;
    const binding = bindingsByTask.get(message.taskId);
    if (!binding) return false;
    if (message.type === "dispatch") return message.to === binding.name;
    if (["heartbeat", "worker_done", "decision_gate"].includes(message.type)) {
      return message.from === binding.name;
    }
    return true;
  });
  if (
    terminalSessionIds.size !== 1 ||
    messageIds.length !== contract.messageIds.length ||
    JSON.stringify(messageIds) !== JSON.stringify(contract.messageIds) ||
    !requiredTypes.every((type) => types.includes(type)) ||
    !workerMessagesJoin ||
    decisionPhase?.gateStatus !== "pending" ||
    finalPhase?.gateStatus !== "resolved" ||
    JSON.stringify(Object.keys(finalPhase?.taskStates ?? {}).sort()) !==
      JSON.stringify([...contract.taskIds].sort()) ||
    Object.values(finalPhase?.taskStates ?? {}).some((status) => status !== "done")
  ) {
    throw new Error("orchestration channel contract is not complete");
  }
  return {
    agentIds: contract.agentBindings.map(({ agentId }) => agentId),
    gateId: contract.gateId,
    messageCount: contract.messageIds.length,
    messageTypes: types,
    phaseIds: contract.phaseIds,
    taskIds: contract.taskIds,
    terminalSessionId: [...terminalSessionIds][0],
  };
}

export function captureInteractionEvidence(captureDiagnostics) {
  const clipboardImagePaste = Object.fromEntries(
    CAPTURE_FORMATS.flatMap((format) => {
      const completed = completedClipboardImagePaste(
        captureDiagnostics[format]?.clipboardImagePaste,
      );
      return completed ? [[format, completed]] : [];
    }),
  );
  const headlessSpawn = Object.fromEntries(
    CAPTURE_FORMATS.flatMap((format) => {
      const completed = completedHeadlessSpawn(
        captureDiagnostics[format]?.headlessSpawn,
      );
      return completed ? [[format, completed]] : [];
    }),
  );
  const orchestrationChannel = Object.fromEntries(
    CAPTURE_FORMATS.flatMap((format) => {
      const completed = completedOrchestrationChannel(
        captureDiagnostics[format]?.orchestrationChannel,
      );
      return completed ? [[format, completed]] : [];
    }),
  );
  return Object.keys(clipboardImagePaste).length > 0 ||
    Object.keys(headlessSpawn).length > 0 ||
    Object.keys(orchestrationChannel).length > 0
    ? {
        schemaVersion: 1,
        ...(Object.keys(clipboardImagePaste).length > 0
          ? { clipboardImagePaste }
          : {}),
        ...(Object.keys(headlessSpawn).length > 0 ? { headlessSpawn } : {}),
        ...(Object.keys(orchestrationChannel).length > 0
          ? { orchestrationChannel }
          : {}),
      }
    : undefined;
}
