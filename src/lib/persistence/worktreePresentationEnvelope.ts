import { DURABLE_APP_STORE_NAME } from "./durableAppStoreName.ts";

export const WORKTREE_PRESENTATION_FILE = "worktree-presentation-v1.json";
const MAX_PRESENTATION_BYTES = 8 * 1024 * 1024;

export function parseWorktreePresentationEnvelope(raw: string): unknown {
	if (raw.length > 17 * 1024 * 1024)
		throw new Error("worktree_presentation_envelope_too_large");
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("worktree_presentation_envelope_json_invalid");
	}
}

export interface WorktreePresentationIdentity {
	sourceChannel: string;
	targetChannel: string;
}

export interface WorktreePresentationEnvelope
	extends WorktreePresentationIdentity {
	schemaVersion: 1;
	storeName: typeof DURABLE_APP_STORE_NAME;
	serializedValue: string;
	sha256: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validatePresentationValue(serialized: unknown): string {
	if (
		typeof serialized !== "string" ||
		serialized.length > MAX_PRESENTATION_BYTES ||
		new TextEncoder().encode(serialized).byteLength > MAX_PRESENTATION_BYTES
	) {
		throw new Error("worktree_presentation_size_invalid");
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error("worktree_presentation_json_invalid");
	}
	if (
		!object(value) ||
		!object(value.state) ||
		!Number.isSafeInteger(value.version) ||
		(value.version as number) < 0
	) {
		throw new Error("worktree_presentation_store_invalid");
	}
	return serialized;
}

function validateIdentity(identity: WorktreePresentationIdentity): void {
	if (
		!/^dev-[a-z0-9-]{1,60}$/.test(identity.sourceChannel) ||
		!/^release-[a-z0-9-]{1,56}$/.test(identity.targetChannel)
	) {
		throw new Error("worktree_presentation_channel_invalid");
	}
}

async function digest(
	identity: WorktreePresentationIdentity,
	serializedValue: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify([
			1,
			DURABLE_APP_STORE_NAME,
			identity.sourceChannel,
			identity.targetChannel,
			serializedValue,
		]),
	);
	const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function createWorktreePresentationEnvelope(
	identity: WorktreePresentationIdentity,
	serializedValue: string,
): Promise<WorktreePresentationEnvelope> {
	validateIdentity(identity);
	validatePresentationValue(serializedValue);
	return {
		schemaVersion: 1,
		storeName: DURABLE_APP_STORE_NAME,
		sourceChannel: identity.sourceChannel,
		targetChannel: identity.targetChannel,
		serializedValue,
		sha256: await digest(identity, serializedValue),
	};
}

export async function readWorktreePresentationEnvelope(
	value: unknown,
	identity: WorktreePresentationIdentity,
): Promise<WorktreePresentationEnvelope> {
	validateIdentity(identity);
	if (
		!object(value) ||
		value.schemaVersion !== 1 ||
		value.storeName !== DURABLE_APP_STORE_NAME ||
		value.sourceChannel !== identity.sourceChannel ||
		value.targetChannel !== identity.targetChannel ||
		typeof value.sha256 !== "string"
	) {
		throw new Error("worktree_presentation_identity_mismatch");
	}
	const serializedValue = validatePresentationValue(value.serializedValue);
	if (value.sha256 !== (await digest(identity, serializedValue))) {
		throw new Error("worktree_presentation_checksum_mismatch");
	}
	return {
		sourceChannel: identity.sourceChannel,
		targetChannel: identity.targetChannel,
		schemaVersion: 1,
		storeName: DURABLE_APP_STORE_NAME,
		serializedValue,
		sha256: value.sha256,
	};
}
