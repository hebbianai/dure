export const AGENT_TRANSCRIPT_SCHEMA_VERSION: 1;
export const AGENT_TRANSCRIPT_ENTRY_LIMITS: readonly [20, 50];

export type AgentTranscriptEntryLimit = number | null;

export interface AgentTranscriptCursorV1 {
  epoch: string;
  sequence: number;
}

export interface AgentTranscriptReadRequestV1 {
  schemaVersion: 1;
  interactionSessionId: string;
  direction: "tail" | "before";
  cursor: AgentTranscriptCursorV1 | null;
  limit: number;
}

export interface AgentTranscriptBindingV1 {
  agentId: string;
  providerId: string;
  interactionSessionId: string;
  timelineEpoch: string;
  historyComplete: boolean;
  source:
    | { kind: "canonical_timeline" }
    | { kind: "provider_transcript"; conversationId: string };
}

export interface ProviderConversationTranscriptV1 {
  schemaVersion: 1;
  provider: string;
  conversationId: string;
  historyComplete: boolean;
  /** Latest provider-marked final answer; absent on older desktop adapters. */
  finalResponse?: string | null;
  entries: Array<{ role: "user" | "agent"; text: string }>;
}

/** The provider conversation a transcript in the shared shape was read from:
 * by this desktop, or, for a Chat session, by the backend that owns it. */
export type ProviderTranscriptSource = {
  kind: "local";
  agentId: string;
  provider: string;
  conversationId: string;
};

/** A conversation whose native CLI transcript this desktop reads itself. */
export type NativeAgentTranscriptSource = ProviderTranscriptSource & {
  provider: "claude" | "codex" | "pi";
};

export type NativeAgentTranscriptSourceResolution =
  | NativeAgentTranscriptSource
  | { kind: "remote" | "identity_unavailable" | "unsupported" };

export type AgentTranscriptEntryV1 =
  | {
      id: string;
      createdAtMs: number;
      kind: "message";
      role: "user" | "assistant";
      text: string;
    }
  | {
      id: string;
      createdAtMs: number;
      kind: "reasoning" | "tool_input" | "history_boundary" | "goal_continuation" | "pending_answer";
      text: string;
    }
  | {
      id: string;
      createdAtMs: number;
      kind: "tool";
      name: string;
      state: "running" | "completed" | "failed" | "canceled";
      input: unknown;
      output: unknown;
    }
  | {
      id: string;
      createdAtMs: number;
      kind: "plan";
      value: unknown;
    }
  | {
      id: string;
      createdAtMs: number;
      kind: "error";
      code: string;
      text: string;
    };

export interface AgentTranscriptV1 {
  schemaVersion: 1;
  kind: "dure.agent_transcript";
  binding: AgentTranscriptBindingV1;
  scope: { kind: "all" } | { kind: "last"; count: number };
  entries: AgentTranscriptEntryV1[];
}

export class AgentTranscriptError extends Error {
  readonly code: string;
}

export function nativeTranscriptProvider(
  provider: unknown,
): provider is NativeAgentTranscriptSource["provider"];

export function nativeAgentTranscriptSource(
  agent: unknown,
  runtimeBinding?: unknown,
): NativeAgentTranscriptSourceResolution;

export function recordedAgentTranscriptSource(
  agent: unknown,
): NativeAgentTranscriptSourceResolution;

export function collectAgentTranscript(input: {
  agentId: string;
  providerId: string;
  interactionSessionId: string;
  entryLimit: AgentTranscriptEntryLimit;
  readPage: (request: AgentTranscriptReadRequestV1) => Promise<unknown>;
}): Promise<AgentTranscriptV1>;

export function agentTranscriptFromProvider(input: {
  source: ProviderTranscriptSource;
  entryLimit: AgentTranscriptEntryLimit;
  transcript: ProviderConversationTranscriptV1;
}): AgentTranscriptV1;

export function formatAgentTranscript(
  transcript: AgentTranscriptV1,
  options?: { json?: boolean },
): string;
