import { presentPendingAnswer } from "./contracts/agent-pending-presentation.mjs";

export const AGENT_TRANSCRIPT_SCHEMA_VERSION = 1;
export const AGENT_TRANSCRIPT_ENTRY_LIMITS = Object.freeze([20, 50]);

const PAGE_ROWS = 128;
const MAX_PAGES = 1_024;
const MAX_ENTRIES = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const encoder = new TextEncoder();

export class AgentTranscriptError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AgentTranscriptError";
  }
}

function fail(code, message) {
  throw new AgentTranscriptError(code, message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function domainId(value) {
  return typeof value === "string" && DOMAIN_ID.test(value);
}

function token(value) {
  return typeof value === "string" && TOKEN.test(value);
}

function cursor(value, epoch) {
  return (
    record(value) &&
    value.epoch === epoch &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  );
}

function binding(value, expected) {
  if (
    !record(value) ||
    value.schemaVersion !== AGENT_TRANSCRIPT_SCHEMA_VERSION ||
    value.interactionSessionId !== expected.interactionSessionId ||
    value.agentId !== expected.agentId ||
    value.providerId !== expected.providerId ||
    !token(value.timelineEpoch) ||
    typeof value.historyComplete !== "boolean"
  ) {
    fail(
      "agent_transcript_response_invalid",
      "The transcript binding is invalid.",
    );
  }
  return {
    agentId: value.agentId,
    providerId: value.providerId,
    interactionSessionId: value.interactionSessionId,
    timelineEpoch: value.timelineEpoch,
    historyComplete: value.historyComplete,
  };
}

function sameBinding(left, right) {
  return (
    left.agentId === right.agentId &&
    left.providerId === right.providerId &&
    left.interactionSessionId === right.interactionSessionId &&
    left.timelineEpoch === right.timelineEpoch
  );
}

function transcriptEntry(row, epoch) {
  if (
    !record(row) ||
    !cursor(row.cursor, epoch) ||
    !record(row.item) ||
    !domainId(row.item.itemId) ||
    !Number.isSafeInteger(row.item.createdAtMs) ||
    row.item.createdAtMs < 0 ||
    !record(row.item.body) ||
    typeof row.item.body.type !== "string"
  ) {
    fail("agent_transcript_response_invalid", "A transcript row is invalid.");
  }
  const base = {
    id: `row:${epoch}:${row.cursor.sequence}`,
    createdAtMs: row.item.createdAtMs,
  };
  const body = row.item.body;
  switch (body.type) {
    case "message":
      if (
        (body.role !== "user" && body.role !== "assistant") ||
        typeof body.markdown !== "string"
      ) {
        fail("agent_transcript_response_invalid", "A message row is invalid.");
      }
      return { ...base, kind: "message", role: body.role, text: body.markdown };
    case "goal_continuation":
      if (typeof body.objective !== "string" || !Number.isSafeInteger(body.goal_revision) || body.goal_revision < 1) {
        fail("agent_transcript_response_invalid", "A goal continuation row is invalid.");
      }
      return { ...base, kind: "goal_continuation", text: body.objective };
    case "pending_answer": {
      const request = body.request?.request;
      if (!record(request) || !["permission", "question"].includes(request.kind)) {
        fail("agent_transcript_response_invalid", "A confirmed answer row is invalid.");
      }
      const presentation = presentPendingAnswer(request, body.answer);
      const text = [presentation.decision, presentation.permission?.title, presentation.permission?.description,
        ...presentation.questions.map(({ question, answer }) => `${question}\n${answer ?? "[hidden]"}`),
      ].filter(Boolean).join("\n\n");
      return { ...base, kind: "pending_answer", text };
    }
    case "reasoning":
      if (typeof body.text !== "string") {
        fail("agent_transcript_response_invalid", "A reasoning row is invalid.");
      }
      return { ...base, kind: "reasoning", text: body.text };
    case "tool": {
      const toolCallId = body.toolCallId ?? body.tool_call_id;
      if (
        !token(toolCallId) ||
        typeof body.name !== "string" ||
        !["running", "completed", "failed", "canceled"].includes(body.state)
      ) {
        fail("agent_transcript_response_invalid", "A tool row is invalid.");
      }
      return {
        ...base,
        kind: "tool",
        name: body.name,
        state: body.state,
        input: body.input,
        output: body.output,
      };
    }
    case "tool_input": {
      const jsonText = body.jsonText ?? body.json_text;
      if (typeof jsonText !== "string") {
        fail("agent_transcript_response_invalid", "A tool input row is invalid.");
      }
      return { ...base, kind: "tool_input", text: jsonText };
    }
    case "plan":
      return { ...base, kind: "plan", value: body.value };
    case "error":
      if (!token(body.code) || typeof body.message !== "string") {
        fail("agent_transcript_response_invalid", "An error row is invalid.");
      }
      return { ...base, kind: "error", code: body.code, text: body.message };
    case "history_boundary":
      if (typeof body.reason !== "string") {
        fail(
          "agent_transcript_response_invalid",
          "A history boundary row is invalid.",
        );
      }
      return { ...base, kind: "history_boundary", text: body.reason };
    case "lifecycle":
    case "provider_evidence":
      return null;
    default:
      fail(
        "agent_transcript_response_invalid",
        `Unsupported transcript row type: ${body.type}`,
      );
  }
}

function liveEntry(value, completedItemIds) {
  if (
    !record(value) ||
    !domainId(value.streamId) ||
    !domainId(value.itemId) ||
    !["assistant", "reasoning", "tool_input"].includes(value.kind) ||
    typeof value.text !== "string" ||
    !Number.isSafeInteger(value.updatedAtMs) ||
    value.updatedAtMs < 0
  ) {
    fail(
      "agent_transcript_response_invalid",
      "A live transcript row is invalid.",
    );
  }
  if (completedItemIds.has(value.itemId)) return null;
  const base = {
    id: `live:${value.streamId}`,
    createdAtMs: value.updatedAtMs,
  };
  if (value.kind === "assistant") {
    return { ...base, kind: "message", role: "assistant", text: value.text };
  }
  return { ...base, kind: value.kind, text: value.text };
}

function parsePage(read, request, expectedBinding, expectedIdentity) {
  if (record(read) && read.type === "reset") {
    fail(
      "agent_transcript_timeline_reset",
      "The conversation timeline changed while the transcript was being read.",
    );
  }
  if (!record(read) || read.type !== "page" || !record(read.page)) {
    fail(
      "agent_transcript_response_invalid",
      "The transcript response is invalid.",
    );
  }
  const page = read.page;
  const parsedBinding = binding(page.binding, {
    ...expectedIdentity,
    interactionSessionId: request.interactionSessionId,
  });
  if (expectedBinding && !sameBinding(parsedBinding, expectedBinding)) {
    fail(
      "agent_transcript_authority_changed",
      "The conversation authority changed while the transcript was being read.",
    );
  }
  if (
    !Array.isArray(page.rows) ||
    page.rows.length > PAGE_ROWS ||
    !Array.isArray(page.liveText) ||
    typeof page.hasMore !== "boolean" ||
    !cursor(page.finalCursor, parsedBinding.timelineEpoch)
  ) {
    fail(
      "agent_transcript_response_invalid",
      "The transcript page is invalid.",
    );
  }
  const sequences = page.rows.map((row) => {
    if (!record(row) || !cursor(row.cursor, parsedBinding.timelineEpoch)) {
      fail("agent_transcript_response_invalid", "A transcript cursor is invalid.");
    }
    return row.cursor.sequence;
  });
  if (
    sequences.some(
      (sequence, index) => index > 0 && sequence <= sequences[index - 1],
    ) ||
    (page.hasMore && sequences.length === 0)
  ) {
    fail(
      "agent_transcript_response_invalid",
      "The transcript page is not ordered.",
    );
  }
  if (request.direction === "tail") {
    if (
      request.cursor !== null ||
      (sequences.length > 0 &&
        sequences.at(-1) !== page.finalCursor.sequence)
    ) {
      fail(
        "agent_transcript_response_invalid",
        "The transcript tail window is invalid.",
      );
    }
  } else if (
    request.direction !== "before" ||
    !cursor(request.cursor, parsedBinding.timelineEpoch) ||
    sequences.some((sequence) => sequence >= request.cursor.sequence) ||
    (sequences.length > 0 && sequences[0] !== page.finalCursor.sequence)
  ) {
    fail(
      "agent_transcript_response_invalid",
      "The transcript history window is invalid.",
    );
  }
  const completedItemIds = new Set(
    page.rows.flatMap((row) =>
      record(row.item) && domainId(row.item.itemId) ? [row.item.itemId] : [],
    ),
  );
  const entries = page.rows
    .map((row) => transcriptEntry(row, parsedBinding.timelineEpoch))
    .filter((entry) => entry !== null);
  const liveEntries = page.liveText
    .map((value) => liveEntry(value, completedItemIds))
    .filter((entry) => entry !== null);
  return {
    binding: parsedBinding,
    entries,
    liveEntries,
    hasMore: page.hasMore,
    beforeCursor:
      sequences.length === 0
        ? null
        : { epoch: parsedBinding.timelineEpoch, sequence: sequences[0] },
  };
}

function validLimit(value) {
  return (
    value === null ||
    (Number.isSafeInteger(value) && value > 0 && value <= MAX_ENTRIES)
  );
}

function transcriptResult(bindingValue, entries, entryLimit) {
  if (entries.length > MAX_ENTRIES) {
    fail(
      "agent_transcript_entry_limit",
      `The transcript exceeds ${MAX_ENTRIES} entries.`,
    );
  }
  return {
    schemaVersion: AGENT_TRANSCRIPT_SCHEMA_VERSION,
    kind: "dure.agent_transcript",
    binding: bindingValue,
    scope:
      entryLimit === null
        ? { kind: "all" }
        : { kind: "last", count: entryLimit },
    entries: entryLimit === null ? entries : entries.slice(-entryLimit),
  };
}

/** Resolves the one exact native provider record shared by pane copy and CLI. */
export function nativeAgentTranscriptSource(agent, runtimeBinding) {
  if (
    !record(agent) ||
    !domainId(agent.id) ||
    !["claude", "codex"].includes(agent.provider)
  ) {
    return { kind: "unsupported" };
  }
  const bindingValue = runtimeBinding ?? agent.runtimeBinding;
  const local = bindingValue
    ? bindingValue.source === "local"
    : agent.sessionKind === "pty";
  if (!local) return { kind: "remote" };
  const identity = bindingValue?.conversationIdentity;
  const conversationId = bindingValue
    ? identity?.providerId === agent.provider
      ? identity.conversationId
      : undefined
    : agent.conversationId;
  if (!domainId(conversationId)) {
    return { kind: "identity_unavailable" };
  }
  return {
    kind: "local",
    agentId: agent.id,
    provider: agent.provider,
    conversationId,
  };
}

/** Converts a provider-owned native CLI transcript into the shared model. */
export function agentTranscriptFromProvider({
  source,
  entryLimit,
  transcript,
}) {
  if (
    !record(source) ||
    source.kind !== "local" ||
    !domainId(source.agentId) ||
    !["claude", "codex"].includes(source.provider) ||
    !domainId(source.conversationId) ||
    !validLimit(entryLimit) ||
    !record(transcript) ||
    transcript.schemaVersion !== AGENT_TRANSCRIPT_SCHEMA_VERSION ||
    transcript.provider !== source.provider ||
    transcript.conversationId !== source.conversationId ||
    typeof transcript.historyComplete !== "boolean" ||
    !Array.isArray(transcript.entries) ||
    transcript.entries.length > MAX_ENTRIES
  ) {
    fail(
      "agent_transcript_response_invalid",
      "The provider transcript response is invalid.",
    );
  }
  const entries = transcript.entries.map((entry, index) => {
    if (
      !record(entry) ||
      !["user", "agent"].includes(entry.role) ||
      typeof entry.text !== "string"
    ) {
      fail(
        "agent_transcript_response_invalid",
        "A provider transcript entry is invalid.",
      );
    }
    return {
      id: `provider:${index + 1}`,
      createdAtMs: index,
      kind: "message",
      role: entry.role === "user" ? "user" : "assistant",
      text: entry.text,
    };
  });
  return transcriptResult(
    {
      agentId: source.agentId,
      providerId: transcript.provider,
      interactionSessionId: transcript.conversationId,
      timelineEpoch: "provider-transcript-v1",
      historyComplete: transcript.historyComplete,
      source: {
        kind: "provider_transcript",
        conversationId: transcript.conversationId,
      },
    },
    entries,
    entryLimit,
  );
}

/**
 * Reads one canonical conversation timeline from newest to oldest. Selection
 * and serialization live here so browser clipboard and CLI stdout cannot
 * drift into different definitions of an entry or "whole conversation".
 */
export async function collectAgentTranscript({
  agentId,
  providerId,
  interactionSessionId,
  entryLimit,
  readPage,
}) {
  if (
    !domainId(agentId) ||
    !domainId(providerId) ||
    !domainId(interactionSessionId) ||
    !validLimit(entryLimit) ||
    typeof readPage !== "function"
  ) {
    fail("agent_transcript_request_invalid", "The transcript request is invalid.");
  }

  let request = {
    schemaVersion: AGENT_TRANSCRIPT_SCHEMA_VERSION,
    interactionSessionId,
    direction: "tail",
    cursor: null,
    limit: PAGE_ROWS,
  };
  let transcriptBinding;
  let liveEntries = [];
  let entries = [];

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const page = parsePage(await readPage(request), request, transcriptBinding, {
      agentId,
      providerId,
    });
    transcriptBinding ??= page.binding;
    if (request.direction === "tail") liveEntries = page.liveEntries;
    entries = [...page.entries, ...entries];
    if (entryLimit === null && entries.length + liveEntries.length > MAX_ENTRIES) {
      fail(
        "agent_transcript_entry_limit",
        `The transcript exceeds ${MAX_ENTRIES} entries.`,
      );
    }
    const selectedCount = entries.length + liveEntries.length;
    if (!page.hasMore || (entryLimit !== null && selectedCount >= entryLimit)) {
      const selected = [...entries, ...liveEntries];
      return transcriptResult(
        { ...transcriptBinding, source: { kind: "canonical_timeline" } },
        selected,
        entryLimit,
      );
    }
    if (!page.beforeCursor) {
      fail(
        "agent_transcript_cursor_unavailable",
        "The next transcript cursor is unavailable.",
      );
    }
    request = {
      ...request,
      direction: "before",
      cursor: page.beforeCursor,
    };
  }
  fail(
    "agent_transcript_page_limit",
    `The transcript exceeds ${MAX_PAGES} pages.`,
  );
}

function indentedJson(value) {
  if (value === null || value === undefined) return "";
  let source;
  try {
    source = JSON.stringify(value, null, 2);
  } catch {
    fail(
      "agent_transcript_serialization_failed",
      "A transcript entry could not be serialized.",
    );
  }
  return source
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function formatEntry(entry) {
  switch (entry.kind) {
    case "message":
      return `## ${entry.role === "user" ? "User" : "Assistant"}\n\n${entry.text}`;
    case "goal_continuation":
      return `## Goal continuation\n\n${entry.text}`;
    case "pending_answer":
      return `## Confirmed answer\n\n${entry.text}`;
    case "reasoning":
      return `## Reasoning\n\n${entry.text}`;
    case "tool": {
      const sections = [`## Tool · ${entry.name} (${entry.state})`];
      const input = indentedJson(entry.input);
      const output = indentedJson(entry.output);
      if (input) sections.push(`### Input\n\n${input}`);
      if (output) sections.push(`### Output\n\n${output}`);
      return sections.join("\n\n");
    }
    case "tool_input":
      return `## Tool input\n\n${entry.text}`;
    case "plan": {
      const value = indentedJson(entry.value);
      return `## Plan${value ? `\n\n${value}` : ""}`;
    }
    case "error":
      return `## Error · ${entry.code}\n\n${entry.text}`;
    case "history_boundary":
      return `## History boundary\n\n> ${entry.text.replaceAll("\n", "\n> ")}`;
    default:
      fail(
        "agent_transcript_serialization_failed",
        "A transcript entry has an unsupported kind.",
      );
  }
}

export function formatAgentTranscript(transcript, { json = false } = {}) {
  if (
    !record(transcript) ||
    transcript.schemaVersion !== AGENT_TRANSCRIPT_SCHEMA_VERSION ||
    transcript.kind !== "dure.agent_transcript" ||
    !record(transcript.binding) ||
    !Array.isArray(transcript.entries)
  ) {
    fail(
      "agent_transcript_serialization_failed",
      "The transcript result is invalid.",
    );
  }
  let output;
  if (json) {
    try {
      output = `${JSON.stringify(transcript, null, 2)}\n`;
    } catch {
      fail(
        "agent_transcript_serialization_failed",
        "The transcript could not be serialized.",
      );
    }
  } else {
    const history = transcript.binding.historyComplete
      ? "complete"
      : "available canonical history only (provider history is incomplete)";
    const sourceIdentity =
      transcript.binding.source?.kind === "provider_transcript"
        ? `- Provider conversation: \`${transcript.binding.source.conversationId}\``
        : `- Interaction session: \`${transcript.binding.interactionSessionId}\``;
    const header = [
      "# Dure agent transcript",
      "",
      `- Agent: \`${transcript.binding.agentId}\``,
      `- Provider: \`${transcript.binding.providerId}\``,
      sourceIdentity,
      `- History: ${history}`,
    ].join("\n");
    const body = transcript.entries.length
      ? transcript.entries.map(formatEntry).join("\n\n---\n\n")
      : "_No transcript entries._";
    output = `${header}\n\n${body}\n`;
  }
  if (encoder.encode(output).byteLength > MAX_OUTPUT_BYTES) {
    fail(
      "agent_transcript_output_limit",
      `The formatted transcript exceeds ${MAX_OUTPUT_BYTES} bytes.`,
    );
  }
  return output;
}
