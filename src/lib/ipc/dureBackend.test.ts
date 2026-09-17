import { describe, expect, it, vi } from "vitest";
import {
	assertDureBackendRouteAuthority,
	createDureBackendRequester,
	DureBackendAuthorityFence,
	dureBackendInvokeFailure,
	parseDureBackendEnvelope,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

function route(
	revision = `sha256:${"a".repeat(64)}`,
	generation = "generation-1",
): DureBackendRouteAuthorityV1 {
	return {
		schemaVersion: 1,
		profileId: "local",
		revision,
		backend: { id: "backend-local", generation },
		target: { source: "local", hostId: "local" },
	};
}

describe("parseDureBackendEnvelope", () => {
	it("accepts one generation-fenced structured result", () => {
		expect(
			parseDureBackendEnvelope({
				schemaVersion: 1,
				backendId: "backend-local",
				backendGeneration: "generation-1",
				routeAuthority: route(),
				result: { schemaVersion: 1, read: { type: "page" } },
			}),
		).toEqual({
			backend: { id: "backend-local", generation: "generation-1" },
			routeAuthority: route(),
			result: { schemaVersion: 1, read: { type: "page" } },
		});
	});

	it("rejects malformed or unversioned results", () => {
		expect(
			parseDureBackendEnvelope({
				schemaVersion: 1,
				backendId: "backend-local",
				backendGeneration: "generation-1",
				routeAuthority: route(),
				result: {},
			}),
		).toBeUndefined();
		expect(
			parseDureBackendEnvelope({
				schemaVersion: 2,
				backendId: "backend-local",
				backendGeneration: "generation-1",
				routeAuthority: route(),
				result: { schemaVersion: 1 },
			}),
		).toBeUndefined();
	});
});

describe("DureBackendAuthorityFence", () => {
	it("orders concurrent selected snapshots without a second generation epoch", () => {
		const authority = new DureBackendAuthorityFence();
		const first = authority.begin();
		const concurrent = authority.begin();
		expect(authority.accept(first, route(undefined, "generation-1"))).toBe(
			true,
		);
		expect(
			authority.accept(
				concurrent,
				route(`sha256:${"b".repeat(64)}`, "generation-1"),
				"complete_snapshot",
			),
		).toBe(true);
		expect(authority.accept(concurrent, route(undefined, "generation-1"))).toBe(
			false,
		);
		expect(
			authority.accept(
				authority.begin(),
				route(`sha256:${"b".repeat(64)}`, "generation-1"),
			),
		).toBe(true);
	});

	it("keeps the later-started initial snapshot when responses finish B then A", async () => {
		let call = 0;
		let resolveA!: (value: unknown) => void;
		let resolveB!: (value: unknown) => void;
		const responseA = new Promise<unknown>((resolve) => {
			resolveA = resolve;
		});
		const responseB = new Promise<unknown>((resolve) => {
			resolveB = resolve;
		});
		const envelope = (generation: string) => ({
			schemaVersion: 1,
			backendId: "backend-local",
			backendGeneration: generation,
			routeAuthority: route(undefined, generation),
			result: { schemaVersion: 1 },
		});
		const request = createDureBackendRequester({
			invokeCommand: vi.fn(async () => (++call === 1 ? responseA : responseB)),
			invalidResponseCode: "invalid",
			invalidResponseMessage: "invalid",
			backendChangedCode: "changed",
			backendChangedMessage: "changed",
			requestFailedCode: "failed",
			requestFailedMessage: "failed",
		});
		const snapshot = () =>
			request(
				"resource.read",
				{ schemaVersion: 1 },
				{ kind: "complete_selected_snapshot" },
			);

		const startedA = snapshot();
		const startedB = snapshot();
		resolveB(envelope("generation-b"));
		await expect(startedB).resolves.toMatchObject({
			backend: { generation: "generation-b" },
		});
		resolveA(envelope("generation-a"));
		await expect(startedA).rejects.toMatchObject({
			code: "changed",
			failure: { kind: "authority_changed" },
		});
	});

	it("does not let an older initial snapshot replace a newer strict observation", async () => {
		let call = 0;
		let resolveSnapshotA!: (value: unknown) => void;
		const snapshotAResponse = new Promise<unknown>((resolve) => {
			resolveSnapshotA = resolve;
		});
		const envelope = (generation: string) => ({
			schemaVersion: 1,
			backendId: "backend-local",
			backendGeneration: generation,
			routeAuthority: route(undefined, generation),
			result: { schemaVersion: 1 },
		});
		const request = createDureBackendRequester({
			invokeCommand: vi.fn(async () => {
				call += 1;
				return call === 1 ? snapshotAResponse : envelope("generation-b");
			}),
			invalidResponseCode: "invalid",
			invalidResponseMessage: "invalid",
			backendChangedCode: "changed",
			backendChangedMessage: "changed",
			requestFailedCode: "failed",
			requestFailedMessage: "failed",
		});
		const snapshotA = request(
			"resource.read",
			{ schemaVersion: 1 },
			{ kind: "complete_selected_snapshot" },
		);
		await expect(
			request("resource.apply", { schemaVersion: 1 }),
		).resolves.toMatchObject({ backend: { generation: "generation-b" } });

		resolveSnapshotA(envelope("generation-a"));
		await expect(snapshotA).rejects.toMatchObject({
			code: "changed",
			failure: { kind: "authority_changed" },
		});
	});
});

describe("Dure backend route IPC", () => {
	it("uses selected for inspection and exact authority for mutation", async () => {
		const invokeCommand = vi.fn(async () => ({
			schemaVersion: 1,
			backendId: "backend-local",
			backendGeneration: "generation-1",
			routeAuthority: route(),
			result: { schemaVersion: 1 },
		}));
		const request = createDureBackendRequester({
			profileId: "local",
			invokeCommand,
			invalidResponseCode: "invalid",
			invalidResponseMessage: "invalid",
			backendChangedCode: "changed",
			backendChangedMessage: "changed",
			requestFailedCode: "failed",
			requestFailedMessage: "failed",
		});

		await request(
			"agent_runtime.inspect",
			{ schemaVersion: 1 },
			{ kind: "complete_selected_snapshot" },
		);
		await request(
			"agent_runtime.transition",
			{ schemaVersion: 1 },
			{ kind: "exact", authority: route() },
		);

		expect(invokeCommand).toHaveBeenNthCalledWith(1, "dure_backend_request", {
			route: { kind: "selected", profileId: "local" },
			operation: "agent_runtime.inspect",
			body: { schemaVersion: 1 },
		});
		expect(invokeCommand).toHaveBeenNthCalledWith(2, "dure_backend_request", {
			route: { kind: "exact", authority: route() },
			operation: "agent_runtime.transition",
			body: { schemaVersion: 1 },
		});
	});

	it("does not reinterpret a newly resolved exact lease through the selected snapshot fence", async () => {
		let generation = "generation-1";
		const invokeCommand = vi.fn(async () => ({
			schemaVersion: 1,
			backendId: "backend-local",
			backendGeneration: generation,
			routeAuthority: route(undefined, generation),
			result: { schemaVersion: 1 },
		}));
		const request = createDureBackendRequester({
			profileId: "local",
			invokeCommand,
			invalidResponseCode: "invalid",
			invalidResponseMessage: "invalid",
			backendChangedCode: "changed",
			backendChangedMessage: "changed",
			requestFailedCode: "failed",
			requestFailedMessage: "failed",
		});

		await request(
			"resource.read",
			{ schemaVersion: 1 },
			{ kind: "complete_selected_snapshot" },
		);
		generation = "generation-2";
		await expect(
			request("resource.apply", { schemaVersion: 1 }),
		).rejects.toMatchObject({
			code: "changed",
			failure: { kind: "authority_changed" },
		});
		await expect(
			request("resource.apply", { schemaVersion: 1 }),
		).rejects.toMatchObject({
			code: "changed",
			failure: { kind: "authority_changed" },
		});
		await expect(
			request(
				"resource.apply",
				{ schemaVersion: 1 },
				{ kind: "exact", authority: route(undefined, generation) },
			),
		).resolves.toMatchObject({ backend: { generation: "generation-2" } });
		await expect(
			request(
				"resource.read",
				{ schemaVersion: 1 },
				{ kind: "complete_selected_snapshot" },
			),
		).resolves.toMatchObject({ backend: { generation: "generation-2" } });
		await expect(
			request("resource.apply", { schemaVersion: 1 }),
		).resolves.toMatchObject({ backend: { generation: "generation-2" } });
	});

	it("lets same-generation snapshots converge in request order", async () => {
		let call = 0;
		let resolveFirst!: (value: unknown) => void;
		let resolveSecond!: (value: unknown) => void;
		const first = new Promise<unknown>((resolve) => {
			resolveFirst = resolve;
		});
		const second = new Promise<unknown>((resolve) => {
			resolveSecond = resolve;
		});
		const envelope = (generation: string) => ({
			schemaVersion: 1,
			backendId: "backend-local",
			backendGeneration: generation,
			routeAuthority: route(undefined, generation),
			result: { schemaVersion: 1 },
		});
		const invokeCommand = vi.fn(async () => {
			call += 1;
			if (call === 1) return envelope("generation-1");
			return call === 2 ? first : second;
		});
		const request = createDureBackendRequester({
			profileId: "local",
			invokeCommand,
			invalidResponseCode: "invalid",
			invalidResponseMessage: "invalid",
			backendChangedCode: "changed",
			backendChangedMessage: "changed",
			requestFailedCode: "failed",
			requestFailedMessage: "failed",
		});
		const snapshot = () =>
			request(
				"resource.read",
				{ schemaVersion: 1 },
				{ kind: "complete_selected_snapshot" },
			);

		await snapshot();
		const firstReplacement = snapshot();
		const laterReplacement = snapshot();
		resolveFirst(envelope("generation-2"));
		await expect(firstReplacement).resolves.toMatchObject({
			backend: { generation: "generation-2" },
		});
		resolveSecond(envelope("generation-2"));
		await expect(laterReplacement).resolves.toMatchObject({
			backend: { generation: "generation-2" },
		});
	});

	it("asserts an exact route locally before remote work", async () => {
		const invokeCommand = vi.fn(async () => route());
		await expect(
			assertDureBackendRouteAuthority(route(), invokeCommand),
		).resolves.toEqual(route());
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_route_assert", {
			route: { kind: "exact", authority: route() },
		});
	});

	it("resolves one selected route into exact authority before work", async () => {
		const invokeCommand = vi.fn(async () => route());
		await expect(
			resolveSelectedDureBackendRouteAuthority("local", invokeCommand),
		).resolves.toEqual(route());
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_route_assert", {
			route: { kind: "selected", profileId: "local" },
		});
	});

	it("rejects a selected route response for a different profile", async () => {
		const invokeCommand = vi.fn(async () => ({
			...route(),
			profileId: "remote",
		}));
		await expect(
			resolveSelectedDureBackendRouteAuthority("local", invokeCommand),
		).rejects.toMatchObject({
			code: "backend_transport_authority_changed",
			failure: { kind: "authority_changed" },
		});
	});

	it("classifies a native route mismatch as authority replacement", () => {
		expect(
			dureBackendInvokeFailure(
				{
					code: "backend_transport_authority_changed",
					message: "changed",
				},
				"fallback",
				"fallback",
			).failure,
		).toEqual({ kind: "authority_changed" });
	});

	it("rejects an exact request response from any other route revision", async () => {
		const requested = route();
		const invokeCommand = vi.fn(async () => ({
			schemaVersion: 1,
			backendId: "backend-local",
			backendGeneration: "generation-1",
			routeAuthority: route(`sha256:${"b".repeat(64)}`),
			result: { schemaVersion: 1 },
		}));
		const request = createDureBackendRequester({
			invokeCommand,
			invalidResponseCode: "invalid",
			invalidResponseMessage: "invalid",
			backendChangedCode: "changed",
			backendChangedMessage: "changed",
			requestFailedCode: "failed",
			requestFailedMessage: "failed",
		});

		await expect(
			request(
				"agent_runtime.transition",
				{ schemaVersion: 1 },
				{ kind: "exact", authority: requested },
			),
		).rejects.toMatchObject({
			code: "changed",
			failure: { kind: "authority_changed" },
		});
	});
});
