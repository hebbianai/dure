import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { parseDureBackendEnvelope } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";

it.runIf(process.env.DURE_BROWSER_DESKTOP_WIRE_RECEIPT)(
	"accepts actual Browser service replies through the unchanged desktop envelope parser",
	() => {
		const path = process.env.DURE_BROWSER_DESKTOP_WIRE_RECEIPT;
		if (!path) throw new Error("Browser wire receipt is required");
		const replies: Record<string, unknown> = JSON.parse(
			readFileSync(path, "utf8"),
		);
		expect(Object.keys(replies).sort()).toEqual([
			"created",
			"listed",
			"missing",
			"profiles",
			"recovered",
			"replayed",
		]);
		for (const [name, result] of Object.entries(replies)) {
			const parsed = parseDureBackendEnvelope({
				schemaVersion: 1,
				backendId: "backend:desktop",
				backendGeneration: "generation:desktop",
				routeAuthority: {
					schemaVersion: 1,
					profileId: "local",
					revision: `sha256:${"a".repeat(64)}`,
					backend: { id: "backend:desktop", generation: "generation:desktop" },
					target: { source: "local", hostId: "local" },
				},
				result,
			});
			expect(parsed, name).toBeDefined();
			expect(parsed?.result, name).toEqual(result);
		}
	},
);

it.runIf(process.env.DURE_BROWSER_DESKTOP_WIRE_RECEIPT)(
	"reads actual list and recovery replies through the Browser client",
	async () => {
		const path = process.env.DURE_BROWSER_DESKTOP_WIRE_RECEIPT;
		if (!path) throw new Error("Browser wire receipt is required");
		const replies = JSON.parse(readFileSync(path, "utf8"));
		const authority: DureBackendRouteAuthorityV1 = {
			schemaVersion: 1,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "backend:desktop", generation: "generation:desktop" },
			target: { source: "local", hostId: "local" },
		};
		const wrap = (result: unknown) => ({
			schemaVersion: 1,
			backendId: authority.backend.id,
			backendGeneration: authority.backend.generation,
			routeAuthority: authority,
			result,
		});
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(wrap(replies.listed))
			.mockResolvedValueOnce(wrap(replies.recovered))
			.mockResolvedValueOnce(wrap(replies.missing));
		const client = createDureBrowserClient(authority, invoke);
		expect(await client.list()).toEqual([]);
		const recovered = await client.receipt("desktop:profile");
		expect(recovered.result).toEqual(replies.created.result);
		expect(recovered.result_available).toBe(true);
		expect(await client.receipt("desktop:missing")).toEqual(replies.missing);
		expect(invoke.mock.calls.map((call) => call[1].body)).toEqual([
			{ kind: "list", workspace_id: "workspace:desktop" },
			{ kind: "receipt", operation_id: "desktop:profile" },
			{ kind: "receipt", operation_id: "desktop:missing" },
		]);
	},
);
