import { invoke } from "@tauri-apps/api/core";
import type { ClientViewNamespaceV1 } from "@/lib/workspace/clientViewState";

const CLIENT_VIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export interface DureClientViewLocalIdentityV1 {
	schemaVersion: 1;
	namespace: ClientViewNamespaceV1;
	clientInstanceId: string;
}

type InvokeCommand = (
	command: string,
	arguments_?: Record<string, never>,
) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function validId(value: unknown): value is string {
	return typeof value === "string" && CLIENT_VIEW_ID.test(value);
}

export function parseDureClientViewLocalIdentity(
	value: unknown,
): DureClientViewLocalIdentityV1 | null {
	const candidate = record(value);
	const namespace = record(candidate?.namespace);
	if (
		candidate?.schemaVersion !== 1 ||
		!namespace ||
		!validId(namespace.tenantId) ||
		!validId(namespace.userId) ||
		!validId(namespace.clientId) ||
		!validId(candidate.clientInstanceId)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		namespace: {
			tenantId: namespace.tenantId,
			userId: namespace.userId,
			clientId: namespace.clientId,
		},
		clientInstanceId: candidate.clientInstanceId,
	};
}

export async function readDureClientViewLocalIdentity(
	invokeCommand: InvokeCommand = invoke,
): Promise<DureClientViewLocalIdentityV1> {
	const identity = parseDureClientViewLocalIdentity(
		await invokeCommand("dure_client_view_local_identity"),
	);
	if (!identity) {
		throw new Error("Dure client view identity response is invalid");
	}
	return identity;
}
