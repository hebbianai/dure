import { invoke } from "@tauri-apps/api/core";
import { isDureBackendProfileIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import { asRecord } from "@/lib/payloadGuards";

export interface DureBackendProfileSummary {
	id: string;
	default: boolean;
	kind: "local" | "ssh";
}

export async function listDureBackendProfiles(): Promise<
	DureBackendProfileSummary[]
> {
	const result = asRecord(await invoke("dure_backend_profiles"));
	if (result?.schemaVersion !== 1 || !Array.isArray(result.profiles))
		throw new Error("backend_profiles_response_invalid");
	return result.profiles.map((value: unknown) => {
		const entry = asRecord(value);
		if (
			!entry ||
			!isDureBackendProfileIdV1(entry.id) ||
			typeof entry.default !== "boolean" ||
			!["local", "ssh"].includes(String(entry.kind))
		)
			throw new Error("backend_profiles_response_invalid");
		return {
			id: entry.id,
			default: entry.default,
			kind: entry.kind as "local" | "ssh",
		};
	});
}
