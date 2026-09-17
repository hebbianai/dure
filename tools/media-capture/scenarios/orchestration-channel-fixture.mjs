const TASKS = Object.freeze([
  Object.freeze({
    id: "t17",
    title: "Audit reconnect generation fences",
    spec: "Trace reattach races and report the exact invariant.",
    assignee: "test-triage",
  }),
  Object.freeze({
    id: "t18",
    title: "Review recovery language",
    spec: "Check that public wording distinguishes restore from recreation.",
    assignee: "copy-review",
  }),
]);

const AGENT_BINDINGS = Object.freeze([
  Object.freeze({
    agentId: "agent-test-triage",
    name: "test-triage",
    panelId: "agent:agent-test-triage",
    provider: "codex",
    sessionId: "session-codex-review",
    taskId: "t17",
  }),
  Object.freeze({
    agentId: "agent-copy-review",
    name: "copy-review",
    panelId: "agent:agent-copy-review",
    provider: "claude",
    sessionId: "session-claude-review",
    taskId: "t18",
  }),
]);

function appendMessages(clock) {
  const state = { messages: [], seq: 0 };
  let timestamp = Date.parse(clock);
  const append = (input) => {
    timestamp += 1_000;
    state.seq += 1;
    const message = {
      ...input,
      id: `m${state.seq}`,
      read: false,
      replyTo: null,
      ts: timestamp,
    };
    state.messages.push(message);
    return message;
  };
  append({
    body: "Split the release proof and report through typed results.",
    from: "release-lead",
    idempotencyKey: "media.release.broadcast.v1",
    metadata: { phase: "dispatch" },
    subject: "Release candidate review",
    taskId: null,
    to: "@all",
    type: "note",
  });
  for (const task of TASKS) {
    append({
      body: task.spec,
      from: "release-lead",
      idempotencyKey: `media.${task.id}.dispatch.v1`,
      metadata: { assignee: task.assignee, phase: "dispatch" },
      subject: `dispatch ${task.id}: ${task.title}`,
      taskId: task.id,
      to: task.assignee,
      type: "dispatch",
    });
  }
  append({
    body: "Focused smoke is running; generation identity is stable.",
    from: "test-triage",
    idempotencyKey: "media.t17.heartbeat.v1",
    metadata: { phase: "verify" },
    subject: "Reconnect audit progress",
    taskId: "t17",
    to: "release-lead",
    type: "heartbeat",
  });
  append({
    body: "README and recovery copy are compared against the runtime contract.",
    from: "copy-review",
    idempotencyKey: "media.t18.heartbeat.v1",
    metadata: { phase: "review" },
    subject: "Recovery copy progress",
    taskId: "t18",
    to: "release-lead",
    type: "heartbeat",
  });
  append({
    body: "Reattach preserves one Host generation; the focused smoke is green.",
    from: "test-triage",
    idempotencyKey: "media.t17.done.v1",
    metadata: { result: "generation_fence_preserved" },
    subject: "Reconnect audit complete",
    taskId: "t17",
    to: "release-lead",
    type: "worker_done",
  });
  append({
    body: "Use preserve for live reattach, but recreate for machine reboot?",
    from: "copy-review",
    idempotencyKey: "media.t18.gate.v1",
    metadata: { options: "preserve,recreate" },
    subject: "Recovery terminology decision",
    taskId: "t18",
    to: "release-lead",
    type: "decision_gate",
  });
  append({
    body: "Decision g1: preserve for reattach; recreate only after reboot.",
    from: "release-lead",
    idempotencyKey: "media.t18.gate-resolution.v1",
    metadata: { gateId: "g1", resolution: "preserve" },
    subject: "Recovery terminology resolved",
    taskId: "t18",
    to: "copy-review",
    type: "note",
  });
  append({
    body: "Copy now matches the runtime boundary; no ambiguous survival claim remains.",
    from: "copy-review",
    idempotencyKey: "media.t18.done.v1",
    metadata: { result: "copy_contract_aligned" },
    subject: "Recovery language complete",
    taskId: "t18",
    to: "release-lead",
    type: "worker_done",
  });
  return state.messages;
}

export function createOrchestrationChannelFixture(clock) {
  const messages = appendMessages(clock);
  const phase = (
    id,
    messageCount,
    taskStates,
    agentComments,
    gateStatus = null,
  ) => ({
    id,
    messageIds: messages.slice(0, messageCount).map(({ id: messageId }) => messageId),
    taskStates,
    agentComments,
    gateStatus,
  });
  return {
    schemaVersion: 1,
    desktopId: "desk-launch",
    coordinator: "release-lead",
    agentBindings: AGENT_BINDINGS.map((binding) => ({ ...binding })),
    tasks: TASKS.map((task) => ({ ...task })),
    messages,
    gate: {
      id: "g1",
      taskId: "t18",
      question: "Which recovery term belongs in the public claim?",
      options: ["preserve", "recreate"],
      resolution: "preserve",
    },
    phases: [
      phase(
        "queued",
        0,
        { t17: "todo", t18: "todo" },
        {
          "agent-test-triage": "Awaiting typed assignment",
          "agent-copy-review": "Awaiting typed assignment",
        },
      ),
      phase(
        "dispatched",
        3,
        { t17: "dispatched", t18: "dispatched" },
        {
          "agent-test-triage": "Accepted t17 · tracing reconnect fences",
          "agent-copy-review": "Accepted t18 · reviewing recovery language",
        },
      ),
      phase(
        "working",
        5,
        { t17: "in-progress", t18: "in-progress" },
        {
          "agent-test-triage": "Heartbeat · focused smoke running",
          "agent-copy-review": "Heartbeat · comparing runtime claims",
        },
      ),
      phase(
        "decision",
        7,
        { t17: "done", t18: "blocked" },
        {
          "agent-test-triage": "Done t17 · generation fence proved",
          "agent-copy-review": "Decision needed · preserve or recreate?",
        },
        "pending",
      ),
      phase(
        "resolved",
        9,
        { t17: "done", t18: "done" },
        {
          "agent-test-triage": "Done t17 · generation fence proved",
          "agent-copy-review": "Done t18 · wording contract aligned",
        },
        "resolved",
      ),
    ],
  };
}
