import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createProviderLaunchDefaultsTransport,
	loadProviderLaunchDefaultsProjection,
	type ProviderLaunchDefaultsDocumentV1,
	type ProviderLaunchDefaultsTransport,
	synchronizeProviderLaunchDefaults,
	updateProviderLaunchPermissionDefault,
} from "@/lib/settings/providerLaunchDefaults";
import { useStore } from "@/store";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const fingerprint = `sha256:${"a".repeat(64)}`;
const backend = { id: "local", generation: "generation-1" };
const document: ProviderLaunchDefaultsDocumentV1 = {
	schemaVersion: 1,
	revision: 1,
	defaults: {
		codex: { permissionMode: "bypass_approvals" },
		claude: { permissionMode: "require_approvals" },
	},
	fingerprint,
};

function envelope(result: Record<string, unknown>, profileId = "hosted-a") {
	return {
		schemaVersion: 1,
		backendId: "remote-backend",
		backendGeneration: "generation-1",
		routeAuthority: testDureBackendRouteAuthority(
			"remote-backend",
			"generation-1",
			profileId,
		),
		result,
	};
}

afterEach(() => {
	mocks.invoke.mockReset();
	useStore.setState({
		agents: [],
		skipPermissions: {},
		providerLaunchDefaults: null,
		providerLaunchDefaultsBackend: null,
		providerLaunchDefaultsProfileId: null,
		providerLaunchDefaultsError: null,
		legacySkipPermissions: undefined,
	});
});

describe("provider launch defaults backend projection", () => {
	it("uses the selected backend profile and rejects malformed authority with a typed failure", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(envelope({ schemaVersion: 1, document }))
			.mockResolvedValueOnce(
				envelope({
					schemaVersion: 1,
					document: { ...document, fingerprint: "sha256:bad" },
				}),
			);
		const transport = createProviderLaunchDefaultsTransport({
			profileId: "hosted-a",
			invokeCommand: invoke,
		});

		await expect(transport.get()).resolves.toMatchObject({ document });
		expect(invoke).toHaveBeenNthCalledWith(1, "dure_backend_request", {
			route: { kind: "selected", profileId: "hosted-a" },
			operation: "provider_launch_defaults.get",
			body: { schemaVersion: 1 },
		});
		await expect(transport.get()).rejects.toMatchObject({
			code: "provider_launch_defaults_malformed",
		});
	});

	it("replaces provider defaults from a newer complete backend snapshot", async () => {
		let generation = "generation-1";
		const invokeCommand = vi.fn(async () => ({
			schemaVersion: 1,
			backendId: "remote-backend",
			backendGeneration: generation,
			routeAuthority: testDureBackendRouteAuthority(
				"remote-backend",
				generation,
				"hosted-a",
			),
			result: { schemaVersion: 1, document },
		}));
		const transport = createProviderLaunchDefaultsTransport({
			profileId: "hosted-a",
			invokeCommand,
		});

		await expect(transport.get()).resolves.toMatchObject({
			backend: { generation: "generation-1" },
		});
		generation = "generation-2";
		await expect(transport.get()).resolves.toMatchObject({
			backend: { generation: "generation-2" },
		});
	});

	it("retains a typed projection failure for the settings surface", async () => {
		mocks.invoke.mockRejectedValue({
			code: "provider_launch_defaults_malformed",
		});

		await expect(synchronizeProviderLaunchDefaults()).rejects.toMatchObject({
			code: "provider_launch_defaults_malformed",
		});
		expect(useStore.getState().providerLaunchDefaultsError).toBe(
			"provider_launch_defaults_malformed",
		);
	});

	it("rejects a document response with the wrong result schema", async () => {
		const transport = createProviderLaunchDefaultsTransport({
			invokeCommand: vi.fn().mockResolvedValue(
				envelope({
					schemaVersion: 2,
					document,
				}),
			),
		});

		await expect(transport.get()).rejects.toMatchObject({
			code: "provider_launch_defaults_response_invalid",
		});
	});

	it("leases one exact backend route before mutating provider defaults", async () => {
		const authorityA = testDureBackendRouteAuthority(
			"backend-a",
			"generation-a",
			"hosted-a",
		);
		const authorityB = testDureBackendRouteAuthority(
			"backend-b",
			"generation-b",
			"hosted-a",
		);
		let selected = authorityA;
		const effects: string[] = [];
		const invokeCommand = vi.fn(async (command, arguments_) => {
			if (command === "dure_backend_route_assert") {
				selected = authorityB;
				return authorityA;
			}
			const request = arguments_ as {
				route:
					| { kind: "selected"; profileId: string }
					| { kind: "exact"; authority: typeof authorityA };
			};
			if (request.route.kind === "selected") selected = authorityB;
			const authority =
				request.route.kind === "exact" ? request.route.authority : selected;
			effects.push(authority.backend.id);
			return {
				schemaVersion: 1,
				backendId: authority.backend.id,
				backendGeneration: authority.backend.generation,
				routeAuthority: authority,
				result: {
					schemaVersion: 1,
					receipt: {
						schemaVersion: 1,
						idempotencyKey: "provider-defaults-route-lease",
						expectedRevision: 1,
						disposition: "updated",
						document: {
							...document,
							revision: 2,
							fingerprint: `sha256:${"b".repeat(64)}`,
						},
						updatedAtMs: 10,
					},
				},
			};
		});
		const transport = createProviderLaunchDefaultsTransport({
			profileId: "hosted-a",
			invokeCommand,
		});

		await transport.put({
			idempotencyKey: "provider-defaults-route-lease",
			expectedRevision: 1,
			defaults: document.defaults,
		});

		expect(effects).toEqual(["backend-a"]);
		expect(invokeCommand).toHaveBeenNthCalledWith(
			1,
			"dure_backend_route_assert",
			{ route: { kind: "selected", profileId: "hosted-a" } },
		);
		expect(invokeCommand.mock.calls[1]?.[1]).toMatchObject({
			route: { kind: "exact", authority: authorityA },
			operation: "provider_launch_defaults.put",
		});
	});

	it("rejects an exact CAS receipt whose document differs from the write", async () => {
		const requestedDefaults = {
			...document.defaults,
			claude: { permissionMode: "bypass_approvals" as const },
		};
		const response = envelope(
			{
				schemaVersion: 1,
				receipt: {
					schemaVersion: 1,
					idempotencyKey: "provider-defaults-ui-binding",
					expectedRevision: 1,
					disposition: "updated",
					document: {
						...document,
						revision: 2,
						defaults: {
							codex: { permissionMode: "require_approvals" },
							claude: { permissionMode: "bypass_approvals" },
						},
						fingerprint: `sha256:${"b".repeat(64)}`,
					},
					updatedAtMs: 10,
				},
			},
			"local",
		);
		const transport = createProviderLaunchDefaultsTransport({
			invokeCommand: vi.fn(async (command) =>
				command === "dure_backend_route_assert"
					? response.routeAuthority
					: response,
			),
		});

		await expect(
			transport.put({
				idempotencyKey: "provider-defaults-ui-binding",
				expectedRevision: 1,
				defaults: requestedDefaults,
			}),
		).rejects.toMatchObject({
			code: "provider_launch_defaults_response_invalid",
		});
	});

	it("writes UI changes through the same backend CAS receipt and projects the result", async () => {
		const updated = {
			...document,
			revision: 2,
			defaults: {
				...document.defaults,
				claude: { permissionMode: "bypass_approvals" as const },
			},
			fingerprint: `sha256:${"b".repeat(64)}`,
		};
		mocks.invoke.mockImplementation(async (command, arguments_) => {
			if (command === "dure_backend_route_assert") {
				return testDureBackendRouteAuthority(
					"remote-backend",
					"generation-1",
					"local",
				);
			}
			const request = arguments_ as {
				operation: string;
				body: Record<string, unknown>;
			};
			return envelope(
				request.operation === "provider_launch_defaults.get"
					? { schemaVersion: 1, document }
					: {
							schemaVersion: 1,
							receipt: {
								schemaVersion: 1,
								idempotencyKey: request.body.idempotencyKey,
								expectedRevision: 1,
								disposition: "updated",
								document: updated,
								updatedAtMs: 10,
							},
						},
				"local",
			);
		});

		await updateProviderLaunchPermissionDefault("claude", true);

		expect(mocks.invoke).toHaveBeenCalledTimes(3);
		expect(mocks.invoke.mock.calls[0]?.[1]).toMatchObject({
			route: { kind: "selected", profileId: "local" },
			operation: "provider_launch_defaults.get",
		});
		expect(mocks.invoke.mock.calls[1]?.[1]).toMatchObject({
			route: { kind: "selected", profileId: "local" },
		});
		expect(mocks.invoke.mock.calls[2]?.[1]).toMatchObject({
			route: { kind: "exact" },
			operation: "provider_launch_defaults.put",
			body: {
				expectedRevision: 1,
				defaults: updated.defaults,
			},
		});
		expect(useStore.getState()).toMatchObject({
			providerLaunchDefaults: updated,
			providerLaunchDefaultsProfileId: "local",
			skipPermissions: { codex: true, claude: true },
		});
	});

	it("derives a CAS write from the same full route snapshot it mutates", async () => {
		const routeA = testDureBackendRouteAuthority(
			"shared-backend",
			"shared-generation",
			"local",
		);
		const routeB = {
			...routeA,
			revision: `sha256:${"b".repeat(64)}`,
		};
		const documentB = {
			...document,
			defaults: {
				codex: { permissionMode: "require_approvals" as const },
				claude: { permissionMode: "require_approvals" as const },
			},
			fingerprint: `sha256:${"c".repeat(64)}`,
		};
		let reads = 0;
		let putBody: Record<string, unknown> | undefined;
		mocks.invoke.mockImplementation(async (command, arguments_) => {
			if (command === "dure_backend_route_assert") return routeB;
			const request = arguments_ as {
				operation: string;
				body: Record<string, unknown>;
			};
			if (request.operation === "provider_launch_defaults.get") {
				reads += 1;
				const authority = reads === 1 ? routeA : routeB;
				return {
					schemaVersion: 1,
					backendId: authority.backend.id,
					backendGeneration: authority.backend.generation,
					routeAuthority: authority,
					result: {
						schemaVersion: 1,
						document: reads === 1 ? document : documentB,
					},
				};
			}
			putBody = request.body;
			return {
				schemaVersion: 1,
				backendId: routeB.backend.id,
				backendGeneration: routeB.backend.generation,
				routeAuthority: routeB,
				result: {
					schemaVersion: 1,
					receipt: {
						schemaVersion: 1,
						idempotencyKey: request.body.idempotencyKey,
						expectedRevision: 1,
						disposition: "updated",
						document: {
							...documentB,
							revision: 2,
							defaults: request.body.defaults,
							fingerprint: `sha256:${"d".repeat(64)}`,
						},
						updatedAtMs: 10,
					},
				},
			};
		});

		await updateProviderLaunchPermissionDefault("claude", true);

		expect(reads).toBe(2);
		expect(putBody?.defaults).toEqual({
			codex: { permissionMode: "require_approvals" },
			claude: { permissionMode: "bypass_approvals" },
		});
		expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length - 1]?.[1]).toMatchObject({
			route: { kind: "exact", authority: routeB },
		});
	});

	it("migrates concurrent legacy windows with CAS put-if-absent receipts", async () => {
		const requests: unknown[] = [];
		const transport = (disposition: "created" | "preserved_existing") =>
			({
				get: vi.fn().mockResolvedValue({ backend, document }),
				put: vi.fn(async (request) => {
					requests.push(request);
					return {
						backend: { id: "local", generation: "generation-1" },
						receipt: {
							schemaVersion: 1 as const,
							idempotencyKey: request.idempotencyKey,
							expectedRevision: 0,
							disposition,
							document,
							updatedAtMs: 10,
						},
					};
				}),
			}) satisfies ProviderLaunchDefaultsTransport;

		const legacy = { codex: true, claude: false };
		const [first, second] = await Promise.all([
			loadProviderLaunchDefaultsProjection(legacy, transport("created")),
			loadProviderLaunchDefaultsProjection(
				legacy,
				transport("preserved_existing"),
			),
		]);
		expect(first).toEqual({ backend, document });
		expect(second).toEqual({ backend, document });
		expect(requests).toHaveLength(2);
		expect(requests[0]).toEqual(requests[1]);
		expect(requests[0]).toMatchObject({
			expectedRevision: 0,
			defaults: {
				codex: { permissionMode: "bypass_approvals" },
				claude: { permissionMode: "require_approvals" },
			},
		});
		expect((requests[0] as { idempotencyKey: string }).idempotencyKey).toMatch(
			/^frontend-provider-defaults-v1:[a-f0-9]{64}$/,
		);
	});

	it("projects the latest document after an exact migration receipt replay", async () => {
		const latest = {
			...document,
			revision: 2,
			defaults: { codex: { permissionMode: "require_approvals" as const } },
			fingerprint: `sha256:${"b".repeat(64)}`,
		};
		const transport = {
			put: vi.fn(async (request) => ({
				backend,
				receipt: {
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					expectedRevision: 0,
					disposition: "created" as const,
					document,
					updatedAtMs: 10,
				},
			})),
			get: vi.fn().mockResolvedValue({ backend, document: latest }),
		} satisfies ProviderLaunchDefaultsTransport;

		await expect(
			loadProviderLaunchDefaultsProjection({ codex: true }, transport),
		).resolves.toEqual({ backend, document: latest });
	});

	it("keeps the legacy value and running mode until a receipt-backed projection is applied", async () => {
		const runningAgent = {
			id: "agent-existing",
			name: "existing",
			provider: "codex",
			projectId: "project-1",
			worktreePath: "/tmp/project",
			sessionId: "session-existing",
			sessionKind: "pty",
			started: true,
		} as Agent;
		useStore.setState({
			agents: [runningAgent],
			skipPermissions: { codex: true },
			providerLaunchDefaults: null,
			providerLaunchDefaultsBackend: null,
			providerLaunchDefaultsProfileId: null,
			legacySkipPermissions: { codex: true },
		});
		const unavailable = {
			get: vi.fn(),
			put: vi.fn().mockRejectedValue(new Error("offline")),
		} satisfies ProviderLaunchDefaultsTransport;

		await expect(
			loadProviderLaunchDefaultsProjection(
				useStore.getState().legacySkipPermissions,
				unavailable,
			),
		).rejects.toThrow("offline");
		expect(useStore.getState().legacySkipPermissions).toEqual({ codex: true });
		expect(useStore.getState().agents[0].skipPermissions).toBeUndefined();

		useStore
			.getState()
			.applyProviderLaunchDefaultsProjection(document, backend, "local");
		expect(useStore.getState().legacySkipPermissions).toBeUndefined();
		expect(useStore.getState().skipPermissions).toMatchObject({
			codex: true,
			claude: false,
		});
		expect(useStore.getState().agents[0].skipPermissions).toBe(true);

		useStore.getState().applyProviderLaunchDefaultsProjection(
			{
				...document,
				revision: 2,
				defaults: { codex: { permissionMode: "require_approvals" } },
				fingerprint: `sha256:${"b".repeat(64)}`,
			},
			backend,
			"local",
		);
		expect(useStore.getState().skipPermissions.codex).toBe(false);
		expect(useStore.getState().agents[0].skipPermissions).toBe(true);
	});

	it("does not let an older refresh roll the backend projection backward", () => {
		useStore
			.getState()
			.applyProviderLaunchDefaultsProjection(document, backend, "local");
		useStore.getState().applyProviderLaunchDefaultsProjection(
			{
				...document,
				revision: 0,
				defaults: { codex: { permissionMode: "require_approvals" } },
				fingerprint: `sha256:${"b".repeat(64)}`,
			},
			backend,
			"local",
		);

		expect(useStore.getState().providerLaunchDefaults).toEqual(document);
		expect(useStore.getState().skipPermissions.codex).toBe(true);
	});

	it("accepts a fresh revision sequence after the selected backend generation changes", () => {
		useStore
			.getState()
			.applyProviderLaunchDefaultsProjection(document, backend, "local");
		const replacement = { id: "local", generation: "generation-2" };
		useStore.getState().applyProviderLaunchDefaultsProjection(
			{
				...document,
				revision: 0,
				defaults: {},
				fingerprint: `sha256:${"b".repeat(64)}`,
			},
			replacement,
			"local",
		);

		expect(useStore.getState().providerLaunchDefaults?.revision).toBe(0);
		expect(useStore.getState().providerLaunchDefaultsBackend).toEqual(
			replacement,
		);
	});
});
