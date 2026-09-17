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
	invoke<Array<ProviderConversationMetadata | null>>("provider_conversation_metadata", {
		targets,
	});

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

export const readProviderConversationTranscript = (
	provider: string,
	conversationId: string,
) =>
	invoke<ProviderConversationTranscript>(
		"read_provider_conversation_transcript",
		{
			provider,
			conversationId,
		},
	);

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
