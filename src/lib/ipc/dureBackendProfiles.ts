import { invoke } from "@tauri-apps/api/core";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	resolveDureBackendSshHost,
} from "@/lib/ipc/dureBackendRoute";
import { isDureBackendProfileIdV1 } from "@/lib/ipc/dureProtocolIdentity";
import { asRecord } from "@/lib/payloadGuards";
import type { SshHostConfig } from "@/types";

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

/** The route of the one backend profile that serves a registered SSH Host,
 * matched by the same transport coordinates every SSH route is checked with.
 * Undefined when no profile reaches the Host, or more than one does. */
export async function resolveSshHostDureBackendRouteAuthority(
	hostId: string,
	hosts: readonly SshHostConfig[],
	runtime: {
		readonly profiles: typeof listDureBackendProfiles;
		readonly resolve: typeof resolveSelectedDureBackendRouteAuthority;
	} = {
		profiles: listDureBackendProfiles,
		resolve: resolveSelectedDureBackendRouteAuthority,
	},
): Promise<DureBackendRouteAuthorityV1 | undefined> {
	const profiles = (await runtime.profiles()).filter(
		(profile) => profile.kind === "ssh",
	);
	const routes = await Promise.all(
		profiles.map((profile) =>
			runtime.resolve(profile.id).catch(() => undefined),
		),
	);
	const serving = routes.filter((route) => {
		if (!route) return false;
		try {
			return (
				resolveDureBackendSshHost(route, hosts, (code) => {
					throw new Error(code);
				}).id === hostId
			);
		} catch {
			return false;
		}
	});
	return serving.length === 1 ? serving[0] : undefined;
}
