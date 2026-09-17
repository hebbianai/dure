import {
	isProviderEffortSelection,
	isProviderModelSelection,
} from "../../../../cli/lib/contracts/provider-launch-selection.mjs";

// Quick-dispatch intent journal: the overlay fsyncs before closing; boot resume
// re-runs whatever is still pending. Attachments are already durable files (Task 8); this
// journal stores their absolute paths, not bytes.
//
// Envelope/verify pattern copied from src/lib/workflows/delegateOnce.ts:16-18,345-362 — same
// schemaVersion envelope, byte-size guard, setItem + read-back verify (throw on mismatch), and
// strict shape validation on read that drops the whole set on any malformed envelope. Errors
// here are internal codes (not user-facing at this layer, matching this cluster's own
// quickDispatchNaming.ts precedent), so no t() catalog entries are needed.

import type { DureAgentRunPermissionOverrideV1 } from "@/lib/ipc/dureAgentRun";
import { supportsCanonicalAgentName } from "@/lib/agents/agentName";
import { isAgentCredentialReferenceV1 } from "@/lib/agents/chat/agentConversationContract";
import { nonNegativeInteger, asRecord as record } from "@/lib/payloadGuards";
import { PROVIDERS, type Provider } from "@/types";

const STORAGE_KEY = "dure:quick-dispatch-intents:v1";
const MAX_INTENTS = 16;
const MAX_STORAGE_BYTES = 256 * 1024;
const INTENT_ID = /^qd_[a-f0-9]{32}$/;
const MAX_PROMPT_BYTES = 16 * 1024; // matches the prompt cap in quickDispatchPrompt.ts
const MAX_PATH_BYTES = 4096; // matches delegateOnce's worktreePath bound
const MAX_NAME_BYTES = 512; // matches delegateOnce's displayName bound
const MAX_SETUP_COMMAND_BYTES = 4 * 1024;
// Matches addAgentCanonicalRun.ts's GIT_OBJECT_ID — a resolved base ref is
// always a full commit SHA (sha1 or sha256).
const GIT_COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface QuickDispatchIntentStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface QuickDispatchIntentFailureV1 {
	code: string;
	message: string;
	atMs: number;
}

export interface QuickDispatchRemoteTarget {
	hostId: string;
	path: string;
	host: string;
	port: number;
	user: string;
	registrationGeneration: string | null;
	sshConfigAlias: string | null;
}

export interface QuickDispatchIntentV1 {
	schemaVersion: 1;
	intentId: string;
	createdAtMs: number;
	promptText: string;
	attachmentPaths: readonly string[];
	projectId: string;
	remoteTarget?: QuickDispatchRemoteTarget;
	providerId: Provider;
	/** Exact non-secret credential profile selected at compose time. Missing
	 * means a journal record written before credential selection shipped. */
	accountId?: string | null;
	model: string | null;
	/** Reasoning-effort selection. Present only when the user picked one,
	 *  so pre-effort journal records stay valid. */
	effort?: string;
	typedName: string | null;
	/** One-run choices; absence preserves the legacy backend/setup defaults. */
	permissionOverride?: DureAgentRunPermissionOverrideV1;
	runSetup?: boolean;
	/** Absent on legacy intents, which retain worktree creation on resume. */
	useWorktree?: boolean;
	/** Name and base commit are absent together until they are atomically pinned
	 *  before the destructive spawn boundary. */
	resolvedName?: string;
	/** Exact commit reused even if the selected ref has moved; null for project-root runs. */
	resolvedBaseSha?: string | null;
	/** Final wrapped setup command. Undefined means a legacy unresolved record;
	 * null means the exact decision was to run no setup command. */
	resolvedSetupCommand?: string | null;
	state: "pending" | "failed";
	failure?: QuickDispatchIntentFailureV1;
}

export interface NewQuickDispatchIntent {
	promptText: string;
	attachmentPaths: readonly string[];
	projectId: string;
	remoteTarget?: QuickDispatchRemoteTarget;
	providerId: Provider;
	accountId: string | null;
	model: string | null;
	effort: string | null;
	typedName: string | null;
	permissionOverride?: DureAgentRunPermissionOverrideV1;
	runSetup?: boolean;
	/** Absent on legacy intents, which retain worktree creation on resume. */
	useWorktree?: boolean;
}

function browserStorage(): QuickDispatchIntentStorage | undefined {
	if (typeof globalThis.localStorage === "undefined") return undefined;
	return globalThis.localStorage;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const observed = Object.keys(value);
	return (
		observed.length === keys.length &&
		keys.every((key) => observed.includes(key))
	);
}

function boundedText(value: unknown, maximumBytes: number): value is string {
	if (typeof value !== "string" || value.length === 0) return false;
	if (new TextEncoder().encode(value).length > maximumBytes) return false;
	return [...value].every((character) => {
		const code = character.charCodeAt(0);
		return (
			(code >= 32 && code !== 127) || character === "\n" || character === "\t"
		);
	});
}

function boundedPath(value: unknown, maximumBytes: number): value is string {
	return (
		boundedText(value, maximumBytes) &&
		(value as string).startsWith("/") &&
		!(value as string).includes("\n") &&
		!(value as string).includes("\t")
	);
}

function nullableText(
	value: unknown,
	maximumBytes: number,
): value is string | null {
	return value === null || boundedText(value, maximumBytes);
}

/** Like `boundedText`, but an empty string is valid when `allowEmpty` is set —
 *  F3: attachment-only dispatch (empty task text, at least one attachment) is
 *  allowed, so `promptText` alone may be empty exactly when there is at least
 *  one attachment to carry the request. */
function boundedPromptText(
	value: unknown,
	maximumBytes: number,
	allowEmpty: boolean,
): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0) return allowEmpty;
	return boundedText(value, maximumBytes);
}

function validModel(value: unknown): value is string | null {
	return (
		value === null ||
		(typeof value === "string" && isProviderModelSelection(value))
	);
}

function validResolvedName(value: unknown): value is string {
	return typeof value === "string" && supportsCanonicalAgentName(value);
}

function validResolvedBaseSha(value: unknown): value is string {
	return typeof value === "string" && GIT_COMMIT_SHA.test(value);
}

function validFailure(value: unknown): value is QuickDispatchIntentFailureV1 {
	const candidate = record(value);
	return (
		!!candidate &&
		exactKeys(candidate, ["code", "message", "atMs"]) &&
		boundedText(candidate.code, 256) &&
		boundedText(candidate.message, 4096) &&
		nonNegativeInteger(candidate.atMs)
	);
}

function validRemoteTarget(value: unknown): value is QuickDispatchRemoteTarget {
	const target = record(value);
	return !!target && exactKeys(target, ["hostId", "path", "host", "port", "user", "registrationGeneration", "sshConfigAlias"]) &&
		boundedText(target.hostId, 256) && boundedPath(target.path, MAX_PATH_BYTES) &&
		boundedText(target.host, 512) && boundedText(target.user, 256) &&
		Number.isInteger(target.port) && Number(target.port) > 0 && Number(target.port) <= 65535 &&
		nullableText(target.registrationGeneration, 256) && nullableText(target.sshConfigAlias, 512);
}

function validIntent(value: unknown): value is QuickDispatchIntentV1 {
	const candidate = record(value);
	if (!candidate) return false;
	const rootKeys = [
		"schemaVersion",
		"intentId",
		"createdAtMs",
		"promptText",
		"attachmentPaths",
		"projectId",
		...(candidate.remoteTarget === undefined ? [] : ["remoteTarget"]),
		"providerId",
		...(candidate.accountId === undefined ? [] : ["accountId"]),
		"model",
		...(candidate.effort === undefined ? [] : ["effort"]),
		"typedName",
		...(candidate.permissionOverride === undefined
			? []
			: ["permissionOverride"]),
		...(candidate.runSetup === undefined ? [] : ["runSetup"]),
		...(candidate.useWorktree === undefined ? [] : ["useWorktree"]),
		"state",
		...(candidate.resolvedName === undefined ? [] : ["resolvedName"]),
		...(candidate.resolvedBaseSha === undefined ? [] : ["resolvedBaseSha"]),
		...(candidate.resolvedSetupCommand === undefined
			? []
			: ["resolvedSetupCommand"]),
		...(candidate.failure === undefined ? [] : ["failure"]),
	];
	// F3: promptText alone may be empty exactly when at least one attachment
	// is present — the assembled prompt (buildQuickDispatchPrompt) is then
	// non-empty from the attachment reference lines alone.
	const attachmentPathsValid =
		Array.isArray(candidate.attachmentPaths) &&
		candidate.attachmentPaths.every((path) =>
			boundedPath(path, MAX_PATH_BYTES),
		);
	const hasAttachments =
		attachmentPathsValid &&
		(candidate.attachmentPaths as readonly unknown[]).length > 0;
	// v1 records written by earlier builds may contain only one or two of the
	// resolution fields. Keep them readable, then pin fills the missing fields
	// without replacing an already-owned value.
	const resolutionValid =
		(candidate.resolvedName === undefined ||
			validResolvedName(candidate.resolvedName)) &&
		(candidate.resolvedBaseSha === undefined ||
			(candidate.useWorktree === false
				? candidate.resolvedBaseSha === null
				: validResolvedBaseSha(candidate.resolvedBaseSha))) &&
		(candidate.resolvedSetupCommand === undefined ||
			candidate.resolvedSetupCommand === null ||
			(candidate.useWorktree !== false &&
				boundedText(candidate.resolvedSetupCommand, MAX_SETUP_COMMAND_BYTES)));
	return (
		candidate.schemaVersion === 1 &&
		exactKeys(candidate, rootKeys) &&
		typeof candidate.intentId === "string" &&
		INTENT_ID.test(candidate.intentId) &&
		nonNegativeInteger(candidate.createdAtMs) &&
		boundedPromptText(candidate.promptText, MAX_PROMPT_BYTES, hasAttachments) &&
		attachmentPathsValid &&
		boundedText(candidate.projectId, 256) &&
		(candidate.remoteTarget === undefined || validRemoteTarget(candidate.remoteTarget)) &&
		typeof candidate.providerId === "string" &&
		Object.keys(PROVIDERS).includes(candidate.providerId) &&
		(candidate.accountId === undefined ||
			candidate.accountId === null ||
			isAgentCredentialReferenceV1(candidate.accountId)) &&
		validModel(candidate.model) &&
		(candidate.effort === undefined ||
			(typeof candidate.effort === "string" &&
				isProviderEffortSelection(candidate.effort))) &&
		nullableText(candidate.typedName, MAX_NAME_BYTES) &&
		(candidate.permissionOverride === undefined ||
			candidate.permissionOverride === "require_approvals" ||
			candidate.permissionOverride === "auto_edit" ||
			candidate.permissionOverride === "bypass_approvals") &&
		(candidate.runSetup === undefined ||
			typeof candidate.runSetup === "boolean") &&
		(candidate.useWorktree === undefined ||
			typeof candidate.useWorktree === "boolean") &&
		resolutionValid &&
		(candidate.state === "pending" || candidate.state === "failed") &&
		(candidate.state === "pending"
			? candidate.failure === undefined
			: validFailure(candidate.failure))
	);
}

function loadIntents(storage = browserStorage()): QuickDispatchIntentV1[] {
	if (!storage) return [];
	const raw = storage.getItem(STORAGE_KEY);
	if (!raw) return [];
	if (new TextEncoder().encode(raw).length > MAX_STORAGE_BYTES) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const journal = record(parsed);
	if (
		journal?.schemaVersion !== 1 ||
		!exactKeys(journal, ["schemaVersion", "intents"]) ||
		!Array.isArray(journal.intents) ||
		journal.intents.length > MAX_INTENTS ||
		!journal.intents.every(validIntent)
	) {
		return [];
	}
	const ids = new Set<string>();
	for (const intent of journal.intents) {
		if (ids.has(intent.intentId)) return [];
		ids.add(intent.intentId);
	}
	return journal.intents;
}

function saveIntents(
	intents: readonly QuickDispatchIntentV1[],
	storage = browserStorage(),
): void {
	if (!storage) throw new Error("quick_dispatch_intent_storage_unavailable");
	if (intents.length === 0) {
		storage.removeItem(STORAGE_KEY);
		return;
	}
	const bounded = intents.slice(-MAX_INTENTS);
	const serialized = JSON.stringify({ schemaVersion: 1, intents: bounded });
	if (new TextEncoder().encode(serialized).length > MAX_STORAGE_BYTES) {
		throw new Error("quick_dispatch_intent_too_large");
	}
	storage.setItem(STORAGE_KEY, serialized);
	if (storage.getItem(STORAGE_KEY) !== serialized) {
		throw new Error("quick_dispatch_intent_commit_failed");
	}
}

/** `qd_` + 32 lowercase hex chars — satisfies the Rust intent-id rule
 *  (`[A-Za-z0-9_-]{1,64}`, src-tauri/src/dropped_files.rs `valid_intent_id`).
 *  Mirrors src/lib/workspace/workspaceImportControl.ts's `planToken()`:
 *  `crypto.getRandomValues` hex-encoded, not `crypto.randomUUID`. */
export function newQuickDispatchIntentId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return `qd_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function readQuickDispatchIntents(
	storage = browserStorage(),
): QuickDispatchIntentV1[] {
	return loadIntents(storage);
}

/** F4: `intentId` lets a caller that already minted an id for a correlated
 *  side effect (the overlay saves attachments to a directory named after the
 *  intent id before the intent itself exists) reuse that exact id instead of
 *  a fresh one being minted here — otherwise the on-disk attachment
 *  directory never correlates with the journaled intent. Omit it to mint a
 *  new id as before; a supplied id must match the same shape a minted one
 *  would (`qd_` + 32 lowercase hex chars). */
export function beginQuickDispatchIntent(
	input: NewQuickDispatchIntent,
	intentId?: string,
	storage = browserStorage(),
): QuickDispatchIntentV1 {
	if (intentId !== undefined && !INTENT_ID.test(intentId)) {
		throw new Error("quick_dispatch_intent_invalid_input");
	}
	const intents = loadIntents(storage);
	const intent: QuickDispatchIntentV1 = {
		schemaVersion: 1,
		intentId: intentId ?? newQuickDispatchIntentId(),
		createdAtMs: Date.now(),
		promptText: input.promptText,
		attachmentPaths: input.attachmentPaths,
		projectId: input.projectId,
		...(input.remoteTarget ? { remoteTarget: input.remoteTarget } : {}),
		providerId: input.providerId,
		accountId: input.accountId,
		model: input.model,
		...(input.effort === null ? {} : { effort: input.effort }),
		typedName: input.typedName,
		...(input.permissionOverride === undefined
			? {}
			: { permissionOverride: input.permissionOverride }),
		...(input.runSetup === undefined ? {} : { runSetup: input.runSetup }),
		...(input.useWorktree === undefined ? {} : { useWorktree: input.useWorktree }),
		state: "pending",
	};
	if (!validIntent(intent)) {
		throw new Error("quick_dispatch_intent_invalid_input");
	}
	const kept =
		intents.length >= MAX_INTENTS
			? intents.slice(intents.length - MAX_INTENTS + 1)
			: intents;
	saveIntents([...kept, intent], storage);
	return intent;
}

export function completeQuickDispatchIntent(
	intentId: string,
	storage = browserStorage(),
): void {
	const intents = loadIntents(storage);
	saveIntents(
		intents.filter((intent) => intent.intentId !== intentId),
		storage,
	);
}

export function failQuickDispatchIntent(
	intentId: string,
	failure: QuickDispatchIntentFailureV1,
	storage = browserStorage(),
): void {
	const intents = loadIntents(storage);
	const current = intents.find((intent) => intent.intentId === intentId);
	if (!current) throw new Error("quick_dispatch_intent_not_found");
	const updated: QuickDispatchIntentV1 = {
		...current,
		state: "failed",
		failure,
	};
	if (!validIntent(updated)) {
		throw new Error("quick_dispatch_intent_invalid_input");
	}
	saveIntents(
		intents.map((intent) => (intent.intentId === intentId ? updated : intent)),
		storage,
	);
}

export interface QuickDispatchIntentResolutionV1 {
	resolvedName: string;
	resolvedBaseSha: string | null;
	resolvedSetupCommand: string | null;
}

/** First-writer authority for every derived launch input. Concurrent resumes
 * receive the already-pinned resolution instead of overwriting it. */
export function pinQuickDispatchIntentResolution(
	intentId: string,
	resolution: QuickDispatchIntentResolutionV1,
	storage = browserStorage(),
): QuickDispatchIntentResolutionV1 {
	const intents = loadIntents(storage);
	const current = intents.find((intent) => intent.intentId === intentId);
	if (!current) throw new Error("quick_dispatch_intent_not_found");
	if (
		current.resolvedName !== undefined &&
		current.resolvedBaseSha !== undefined &&
		current.resolvedSetupCommand !== undefined
	) {
		return {
			resolvedName: current.resolvedName,
			resolvedBaseSha: current.resolvedBaseSha,
			resolvedSetupCommand: current.resolvedSetupCommand,
		};
	}
	const pinned: QuickDispatchIntentResolutionV1 = {
		resolvedName: current.resolvedName ?? resolution.resolvedName,
		resolvedBaseSha: current.resolvedBaseSha === undefined
			? resolution.resolvedBaseSha
			: current.resolvedBaseSha,
		resolvedSetupCommand:
			current.resolvedSetupCommand === undefined
				? resolution.resolvedSetupCommand
				: current.resolvedSetupCommand,
	};
	const updated: QuickDispatchIntentV1 = {
		...current,
		...pinned,
	};
	if (!validIntent(updated)) {
		throw new Error("quick_dispatch_intent_invalid_input");
	}
	saveIntents(
		intents.map((intent) => (intent.intentId === intentId ? updated : intent)),
		storage,
	);
	return pinned;
}
