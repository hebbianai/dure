import type { createDureBackendRequester } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { asRecord } from "@/lib/payloadGuards";

export interface DureProjectOption {
	id: string;
	displayName: string;
}

export async function readDureProjects(
	request: ReturnType<typeof createDureBackendRequester>,
	authority: DureBackendRouteAuthorityV1,
	invalid: () => never,
): Promise<{ projects: DureProjectOption[]; complete: boolean }> {
	const { result } = await request(
		"projects.list",
		{ schemaVersion: 1, maxItems: 128 },
		{ kind: "exact", authority },
	);
	if (!Array.isArray(result.projects) || typeof result.complete !== "boolean")
		invalid();
	const projects = result.projects.map((value) => {
		const project = asRecord(value);
		if (
			!project ||
			typeof project.id !== "string" ||
			!project.id ||
			typeof project.displayName !== "string"
		)
			invalid();
		return { id: project.id, displayName: project.displayName };
	});
	return { projects, complete: result.complete };
}
