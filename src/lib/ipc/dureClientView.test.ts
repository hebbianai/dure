import { describe, expect, it, vi } from "vitest";
import { createDureClientViewStateTransport } from "@/lib/ipc/dureClientView";
import { EMPTY_CLIENT_VIEW_PRESENTATION_V1 } from "@/lib/workspace/clientViewState";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const namespace = {
	tenantId: "tenant",
	userId: "user",
	clientId: "desktop",
};

describe("Dure client-view IPC transport", () => {
	it("maps the four typed operations onto the selected backend profile", async () => {
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const body = arguments_.body as Record<string, unknown>;
			const operation = arguments_.operation;
			let result: Record<string, unknown>;
			if (operation === "client_view.authority.read")
				result = { authority: null };
			else if (operation === "client_view.read") result = { record: null };
			else if (operation === "client_view.generation.advance") {
				result = {
					receipt: {
						schemaVersion: 1,
						idempotencyKey: body.idempotencyKey,
						authority: {
							schemaVersion: 1,
							namespace: body.namespace,
							clientGeneration: 1,
							clientInstanceId: body.nextInstanceId,
							updatedAtMs: 1,
						},
					},
				};
			} else {
				result = {
					receipt: {
						schemaVersion: 1,
						idempotencyKey: body.idempotencyKey,
						record: {
							schemaVersion: 1,
							identity: body.identity,
							revision: 1,
							presentation: body.presentation,
							updatedAtMs: 1,
						},
					},
				};
			}
			return {
				schemaVersion: 1,
				backendId: "remote-backend",
				backendGeneration: "remote-v1",
				routeAuthority: testDureBackendRouteAuthority(
					"remote-backend",
					"remote-v1",
					"remote",
				),
				result: { schemaVersion: 1, ...result },
			};
		});
		const transport = createDureClientViewStateTransport({
			profileId: "remote",
			invokeCommand,
		});
		expect(await transport.readAuthority(namespace)).toEqual({
			ok: true,
			value: null,
		});
		expect(
			await transport.readView({
				namespace,
				clientGeneration: 1,
				clientInstanceId: "instance",
				viewId: "primary",
			}),
		).toEqual({ ok: true, value: null });
		expect(
			await transport.advanceGeneration({
				schemaVersion: 1,
				namespace,
				idempotencyKey: "advance-1",
				expectedGeneration: 0,
				nextInstanceId: "instance",
			}),
		).toMatchObject({ ok: true });
		expect(
			await transport.writeView({
				schemaVersion: 1,
				identity: {
					namespace,
					clientGeneration: 1,
					clientInstanceId: "instance",
					viewId: "primary",
				},
				idempotencyKey: "write-1",
				expectedRevision: 0,
				presentation: EMPTY_CLIENT_VIEW_PRESENTATION_V1,
			}),
		).toMatchObject({ ok: true });
		expect(invokeCommand).toHaveBeenCalledTimes(4);
		expect(invokeCommand.mock.calls[0]).toEqual([
			"dure_backend_request",
			expect.objectContaining({
				route: { kind: "selected", profileId: "remote" },
				operation: "client_view.authority.read",
			}),
		]);
		expect(invokeCommand.mock.calls.map((call) => call[1].operation)).toEqual([
			"client_view.authority.read",
			"client_view.read",
			"client_view.generation.advance",
			"client_view.write",
		]);
	});

	it("keeps a client-view mutation on the authority of its complete snapshot", async () => {
		const authorityA = testDureBackendRouteAuthority(
			"backend-a",
			"generation-a",
			"remote",
		);
		const authorityB = testDureBackendRouteAuthority(
			"backend-b",
			"generation-b",
			"remote",
		);
		let selected = authorityA;
		const effects: string[] = [];
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const operation = arguments_.operation;
			if (operation === "client_view.authority.read") {
				const observed = selected;
				selected = authorityB;
				return {
					schemaVersion: 1,
					backendId: observed.backend.id,
					backendGeneration: observed.backend.generation,
					routeAuthority: observed,
					result: { schemaVersion: 1, authority: null },
				};
			}
			const route = arguments_.route as
				| { kind: "selected"; profileId: string }
				| { kind: "exact"; authority: typeof authorityA };
			const target = route.kind === "exact" ? route.authority : selected;
			effects.push(target.backend.id);
			return {
				schemaVersion: 1,
				backendId: target.backend.id,
				backendGeneration: target.backend.generation,
				routeAuthority: target,
				result: {
					schemaVersion: 1,
					receipt: {
						schemaVersion: 1,
						idempotencyKey: arguments_.body.idempotencyKey,
						authority: {
							schemaVersion: 1,
							namespace,
							clientGeneration: 1,
							clientInstanceId: "instance",
							updatedAtMs: 1,
						},
					},
				},
			};
		});
		const transport = createDureClientViewStateTransport({
			profileId: "remote",
			invokeCommand,
		});
		await transport.readAuthority(namespace);

		const advanced = await transport.advanceGeneration({
			schemaVersion: 1,
			namespace,
			idempotencyKey: "advance-exact-route",
			expectedGeneration: 0,
			nextInstanceId: "instance",
		});

		expect(effects).toEqual(["backend-a"]);
		expect(advanced).toMatchObject({ ok: true });
		expect(invokeCommand.mock.calls[1]?.[1]).toMatchObject({
			route: { kind: "exact", authority: authorityA },
			operation: "client_view.generation.advance",
		});
	});

	it("preserves structured CAS conflicts for the sync controller", async () => {
		const transport = createDureClientViewStateTransport({
			invokeCommand: vi.fn(async () => {
				throw {
					code: "client_view_revision_conflict",
					message: "revision conflict",
					details: { actualRevision: 7 },
				};
			}),
		});
		const result = await transport.readAuthority(namespace);
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "revision_conflict",
				actualRevision: 7,
				message: "revision conflict",
			},
		});
	});

	it("classifies native route replacement as backend change", async () => {
		for (const code of [
			"backend_transport_authority_changed",
			"backend_transport_generation_changed",
		]) {
			const transport = createDureClientViewStateTransport({
				invokeCommand: vi.fn(async () => {
					throw { code, message: "route changed" };
				}),
			});

			expect(await transport.readAuthority(namespace)).toEqual({
				ok: false,
				error: { kind: "backend_changed", message: "route changed" },
			});
		}
	});

	it("replaces a complete selected read when the backend generation changes", async () => {
		let generation = "generation-a";
		const invokeCommand = vi.fn(async (_command, arguments_) => ({
			schemaVersion: 1,
			backendId: "remote",
			backendGeneration: generation,
			routeAuthority: testDureBackendRouteAuthority("remote", generation),
			result: {
				schemaVersion: 1,
				...(arguments_.operation === "client_view.authority.read"
					? { authority: null }
					: { record: null }),
			},
		}));
		const transport = createDureClientViewStateTransport({ invokeCommand });
		expect(await transport.readAuthority(namespace)).toEqual({
			ok: true,
			value: null,
		});
		generation = "generation-b";
		expect(
			await transport.readView({
				namespace,
				clientGeneration: 1,
				clientInstanceId: "instance",
				viewId: "primary",
			}),
		).toEqual({ ok: true, value: null });
		expect(await transport.readAuthority(namespace)).toEqual({
			ok: true,
			value: null,
		});
	});

	it("treats transport pressure as offline and malformed success as fatal", async () => {
		const unavailable = createDureClientViewStateTransport({
			invokeCommand: vi.fn(async () => {
				throw { code: "backend_transport_queue_overflow", message: "full" };
			}),
		});
		expect(await unavailable.readAuthority(namespace)).toMatchObject({
			ok: false,
			error: { kind: "unavailable" },
		});

		const malformed = createDureClientViewStateTransport({
			invokeCommand: vi.fn(async () => ({ schemaVersion: 1, result: {} })),
		});
		expect(await malformed.readAuthority(namespace)).toMatchObject({
			ok: false,
			error: { kind: "fatal" },
		});

		const malformedRecord = createDureClientViewStateTransport({
			invokeCommand: vi.fn(async () => ({
				schemaVersion: 1,
				backendId: "remote",
				backendGeneration: "generation",
				result: {
					schemaVersion: 1,
					record: {
						schemaVersion: 1,
						identity: {
							namespace,
							clientGeneration: 1,
							clientInstanceId: "instance",
							viewId: "primary",
						},
						revision: 1,
						updatedAtMs: 1,
						presentation: {
							...EMPTY_CLIENT_VIEW_PRESENTATION_V1,
							layout: [
								{
									paneId: "pane",
									groupId: "group",
									order: 0,
									sizeBasisPoints: 0,
								},
							],
						},
					},
				},
			})),
		});
		expect(
			await malformedRecord.readView({
				namespace,
				clientGeneration: 1,
				clientInstanceId: "instance",
				viewId: "primary",
			}),
		).toMatchObject({ ok: false, error: { kind: "fatal" } });
	});
});
