// ipc/conversations — provider 대화 목록(재개).
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).

import { invoke } from "@tauri-apps/api/core";
import type { ProviderConversationTranscriptV1 } from "../../../cli/lib/agent-transcript.mjs";
import type { SshConnectOpts } from "./sessions";

// ---------- conversations (resume) ----------

export interface Conversation {
	id: string;
	title: string;
	mtime: number; // unix secs
}

export interface ConversationCredentialProfile {
	referenceId: string;
	directory: string;
}

export interface ProviderConversationMetadataTarget {
	provider: string;
	conversationId: string;
	cwd: string;
	credentialProfile?: ConversationCredentialProfile;
	/** Remote change token from the previous observation; local reads ignore it. */
	observed?: string;
}

export interface ProviderConversationMetadata {
	title: string | null;
	activityAt: string | null;
	/** Bounded provider user messages, oldest first; absent on older adapters. */
	recentPrompts?: string[];
	/** Remote only: the transcript still matches the echoed token, so the
	 * previous observation stands and the other fields are absent. */
	unchanged?: boolean;
	/** Remote only: opaque change token to echo on the next lookup. */
	observed?: string;
}

export type ProviderConversationTranscript = ProviderConversationTranscriptV1;

export type ProviderToolCallState =
	| "running"
	| "completed"
	| "failed"
	| "canceled";

/** One tool call the agent made between the transcript's messages, as this
 * desktop read it from the provider's own records. The input is bounded and
 * the output stays in the terminal. */
export interface ProviderToolCall {
	/** How many of the transcript's `entries` come before this call. */
	afterEntries: number;
	callId: string;
	/** The provider's tool name (`Bash`, `Read`…), or a Codex item kind
	 * (`commandExecution`, `fileChange`…). */
	name: string;
	state: ProviderToolCallState;
	input: unknown;
}

/** A transcript read with `includeTools`. Older desktops answer without
 * `tools`, and so does a conversation without tool calls. */
export interface ProviderConversationActivity
	extends ProviderConversationTranscriptV1 {
	tools?: unknown;
}

export const listConversations = (
	cwd: string,
	provider: string,
	credentialProfile?: ConversationCredentialProfile,
) =>
	invoke<Conversation[]>("list_conversations", {
		cwd,
		provider,
		credentialProfile: credentialProfile ?? null,
	});

/** Resolve exact provider-owned titles and activity in one bounded local request.
 * Results are positional so this filesystem adapter never needs Agent ids. */
export const providerConversationMetadata = (
	targets: readonly ProviderConversationMetadataTarget[],
) =>
	invoke<Array<ProviderConversationMetadata | null>>(
		"provider_conversation_metadata",
		{
			targets,
		},
	);

/** The same exact lookups on one registered SSH host. Only the reviewed
 * relative credential root crosses the SSH boundary; results stay positional. */
export const sshProviderConversationMetadata = (
	opts: SshConnectOpts,
	targets: readonly ProviderConversationMetadataTarget[],
) =>
	invoke<Array<ProviderConversationMetadata | null>>(
		"ssh_provider_conversation_metadata",
		{ opts, targets },
	);

export function readProviderConversationTranscript(
	provider: string,
	conversationId: string,
): Promise<ProviderConversationTranscript>;
/** With `includeTools`, the answer also carries the tool calls between the
 * messages; the entries are the same either way. */
export function readProviderConversationTranscript(
	provider: string,
	conversationId: string,
	options: { includeTools: true },
): Promise<ProviderConversationActivity>;
export function readProviderConversationTranscript(
	provider: string,
	conversationId: string,
	options?: { includeTools: true },
) {
	return invoke<ProviderConversationActivity>(
		"read_provider_conversation_transcript",
		options?.includeTools
			? { provider, conversationId, includeTools: true }
			: { provider, conversationId },
	);
}

export type BackgroundWorkKind = "subagent" | "workflow" | "shell" | "monitor";

/** One running piece of an agent's background work, as the desktop read it
 * from the provider's records behind the Host's facts. */
export interface BackgroundWorkItem {
	id: string;
	kind: BackgroundWorkKind;
	/** The model-written description; never a command. */
	label?: string | null;
	startedUnixMs: number;
	steps?: { done: number; total: number } | null;
	tokens?: number | null;
}

export interface BackgroundWorkList {
	/** Newest first, at most 64. */
	items: BackgroundWorkItem[];
	/** Every running item, including those cut from `items`. */
	counts: {
		subagents: number;
		workflows: number;
		shells: number;
		monitors: number;
	};
	truncated: boolean;
}

export const readAgentBackgroundWork = (
	workspaceId: string,
	sessionId: string,
) =>
	invoke<BackgroundWorkList>("read_agent_background_work", {
		workspaceId,
		sessionId,
	});

export const sshListConversations = (opts: {
	id?: string;
	connectOpts?: SshConnectOpts;
	cwd: string;
	provider: string;
	credentialProfile?: ConversationCredentialProfile;
}) =>
	invoke<Conversation[]>("ssh_list_conversations", {
		id: opts.id ?? null,
		opts: opts.connectOpts ?? null,
		cwd: opts.cwd,
		provider: opts.provider,
		credentialProfile: opts.credentialProfile ?? null,
	});
