import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export function testDureBackendRouteAuthority(
	backendId: string,
	generation: string,
	profileId = "local",
): DureBackendRouteAuthorityV1 {
	return {
		schemaVersion: 1,
		profileId,
		revision: `sha256:${"a".repeat(64)}`,
		backend: { id: backendId, generation },
		target:
			profileId === "local"
				? { source: "local", hostId: "local" }
				: {
						source: "ssh",
						hostId: profileId,
						remote: {
							host: "backend.example.test",
							port: 22,
							user: "dure",
						},
					},
	};
}
