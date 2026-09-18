import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	parseBrowserControl,
	parseBrowserObservation,
} from "@/lib/browser/browserResourceContract";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";

const route: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend:one", generation: "generation:one" },
	target: { source: "local", hostId: "local" },
};
const resource = {
	resource_id: "browser:one",
	generation: "generation:one",
	workspace_id: "workspace:one",
};
const page = {
	resource,
	page_id: "page:one",
	document_revision: "9007199254740993",
};
const lease = {
	resource,
	controller_id: "controller:one",
	epoch: "9007199254740995",
};
const control = {
	resource,
	revision: "9007199254740997",
	phase: "ready",
	controller: lease,
	requested_controller: null,
	in_flight: null,
	next_command_sequence: "9007199254740999",
};
const observation = {
	control,
	pages: [
		{
			page,
			url: "https://example.com",
			title: "Shared page",
			profile_id: "default",
		},
	],
};

function envelope(result: unknown, routeAuthority = route) {
	return {
		schemaVersion: 1,
		backendId: routeAuthority.backend.id,
		backendGeneration: routeAuthority.backend.generation,
		routeAuthority,
		result,
	};
}

function reply(result: unknown, operationId: string | null = null) {
	return envelope({
		schemaVersion: 1,
		operation_id: operationId,
		replayed: false,
		result,
	});
}

describe("Browser creation receipt recovery", () => {
	it("creates personal browsing on the exact route and uses the returned workspace identity", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue(reply({ control }, "create:personal"));
		await expect(
			createDureBrowserClient(route, invoke).create("create:personal"),
		).resolves.toEqual(control);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke.mock.calls[0][1]).toMatchObject({
			route: { kind: "exact", authority: route },
			body: { kind: "create", operation_id: "create:personal" },
		});
		expect(invoke.mock.calls[0][1].body).not.toHaveProperty("workspace_id");
	});
	const operationId = "create:missing-installation";
	const failed = {
		schemaVersion: 1,
		operation_id: operationId,
		replayed: true,
		result_available: true,
		result: null,
		error: { code: "browser_engine_not_installed" },
		receipt: {
			operationId,
			operationKind: "browser.resource",
			state: "failed",
			terminalCode: "browser_engine_not_installed",
		},
	};
	it("preserves the terminal failure from the exact journaled create", async () => {
		const invoke = vi.fn().mockResolvedValue(envelope(failed));
		await expect(
			createDureBrowserClient(route, invoke).create(operationId),
		).rejects.toMatchObject({
			code: "browser_engine_not_installed",
			failure: { kind: "operation", disposition: "terminal" },
		});
		expect(invoke).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ ...failed, result_available: false },
		{ ...failed, receipt: null },
		...[
			{ operationId: "create:other" },
			{ operationKind: "another.operation" },
			{ state: "running" },
			{ state: "succeeded" },
			{ terminalCode: "browser_operation_outcome_unknown" },
		].map((change) => ({
			...failed,
			receipt: { ...failed.receipt, ...change },
		})),
	])(
		"does not interpret an incomplete or unrelated receipt as a safe failure (%j)",
		async (result) => {
			const invoke = vi.fn().mockResolvedValue(envelope(result));
			await expect(
				createDureBrowserClient(route, invoke).create(operationId),
			).rejects.toMatchObject({ code: "browser_desktop_response_invalid" });
			expect(invoke).toHaveBeenCalledTimes(1);
		},
	);
});

describe("Shared Browser selection", () => {
	const target = {
		workspace_id: resource.workspace_id,
		generation: resource.generation,
		revision: "9007199254740993",
		current_resource: null,
	};
	const selected = {
		...target,
		revision: "9007199254740994",
		current_resource: resource,
	};
	it("rejects a catalog whose ownership disagrees with its target", async () => {
		const invoke = vi.fn().mockResolvedValue(
			reply({
				workspace_id: "foreign",
				resources: [],
				target,
			}),
		);
		await expect(
			createDureBrowserClient(route, invoke).list(),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
	it("uses the exact route and shared selection fence without taking input control", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValueOnce(
				reply({
					workspace_id: resource.workspace_id,
					resources: [control],
					target,
				}),
			)
			.mockResolvedValueOnce(reply({ target: selected }, "operation:select"));
		expect(
			await createDureBrowserClient(route, invoke).selectResource(
				resource,
				"operation:select",
			),
		).toEqual(selected);
		expect(invoke.mock.calls.map(([, args]) => args.body)).toEqual([
			{ kind: "list" },
			{
				kind: "select_resource",
				resource,
				expected: target,
				operation_id: "operation:select",
			},
		]);
		for (const [, args] of invoke.mock.calls)
			expect(args.route).toEqual({ kind: "exact", authority: route });
	});
	it.each(["missing", "generation", "revision", "response", "lost"])(
		"fails closed without retrying %s",
		async (fault) => {
			const invoke = vi.fn().mockResolvedValueOnce(
				reply({
					workspace_id: resource.workspace_id,
					resources:
						fault === "missing"
							? []
							: [
									{
										...control,
										resource:
											fault === "generation"
												? { ...resource, generation: "replacement" }
												: resource,
									},
								],
					target: fault === "revision" ? { ...target, revision: "01" } : target,
				}),
			);
			if (fault === "lost")
				invoke.mockRejectedValueOnce(new Error("response lost"));
			else
				invoke.mockResolvedValueOnce(
					reply(
						{ target: { ...selected, revision: target.revision } },
						"operation:select",
					),
				);
			await expect(
				createDureBrowserClient(route, invoke).selectResource(
					resource,
					"operation:select",
				),
			).rejects.toThrow();
			expect(invoke).toHaveBeenCalledTimes(
				["response", "lost"].includes(fault) ? 2 : 1,
			);
		},
	);
});

describe("Browser profile page changes", () => {
	it.each([
		"profile",
		"resource",
		"page",
		"revision",
		"clone-source",
		"clone-reuses-page",
	] as const)("rejects a mismatched profile result: %s", async (fault) => {
		const kind = fault.startsWith("clone-") ? "profile_clone" : "profile_set";
		const changed = {
			...page,
			page_id: kind === "profile_clone" ? "page:clone" : page.page_id,
		};
		const data = {
			page: changed,
			profile_id: "profile:chosen",
			source_page: page,
		};
		if (fault === "profile") data.profile_id = "profile:other";
		if (fault === "resource")
			data.page = {
				...changed,
				resource: { ...resource, generation: "generation:other" },
			};
		if (fault === "page") data.page = { ...changed, page_id: "page:other" };
		if (fault === "revision")
			data.page = { ...changed, document_revision: "1" };
		if (fault === "clone-source")
			data.source_page = { ...page, document_revision: "1" };
		if (fault === "clone-reuses-page") data.page = page;
		const authority = {
			lease,
			page,
			operation_id: "operation:profile",
			command_sequence: control.next_command_sequence,
		};
		const invoke = vi
			.fn()
			.mockResolvedValue(
				reply(
					{ control, observation: null, response: { success: true, data } },
					authority.operation_id,
				),
			);
		await expect(
			createDureBrowserClient(route, invoke).action(
				lease.controller_id,
				authority,
				{ kind, profile_id: "profile:chosen" },
			),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
	it("rejects an invalid profile before contact and never repeats a lost clone response", async () => {
		const authority = {
			lease,
			page,
			operation_id: "operation:profile",
			command_sequence: control.next_command_sequence,
		};
		const invoke = vi.fn().mockRejectedValue(new Error("response lost"));
		const client = createDureBrowserClient(route, invoke);
		await expect(
			client.action(lease.controller_id, authority, {
				kind: "profile_set",
				profile_id: "bad id",
			}),
		).rejects.toThrow();
		expect(invoke).not.toHaveBeenCalled();
		await expect(
			client.action(lease.controller_id, authority, {
				kind: "profile_clone",
				profile_id: "profile:chosen",
			}),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledTimes(1);
	});
	it.each(["profile_set", "profile_clone"] as const)(
		"routes %s through the existing admitted profile operation",
		async (kind) => {
			const changed = {
				...page,
				page_id: kind === "profile_clone" ? "page:clone" : page.page_id,
				document_revision: String(BigInt(page.document_revision) + 1n),
			};
			const authority = {
				lease,
				page,
				operation_id: "operation:profile",
				command_sequence: control.next_command_sequence,
			};
			const invoke = vi.fn().mockResolvedValue(
				reply(
					{
						control: { ...control, current_page: changed },
						response: {
							success: true,
							data: {
								page: changed,
								profile_id: "profile:chosen",
								source_page: page,
							},
						},
						observation: null,
					},
					authority.operation_id,
				),
			);
			const result = await createDureBrowserClient(route, invoke).action(
				lease.controller_id,
				authority,
				{ kind, profile_id: "profile:chosen" },
			);
			expect(invoke).toHaveBeenCalledTimes(1);
			expect(invoke.mock.calls[0]?.[1].body).toEqual({
				kind,
				caller: lease.controller_id,
				authority,
				profile_id: "profile:chosen",
			});
			expect(
				kind === "profile_clone" ? result.createdPage : result.replacedPage,
			).toEqual(changed);
		},
	);
});

describe("Browser desktop authority", () => {
	it("returns the created Host identity independently of native tab labels", async () => {
		const created = { ...page, page_id: "page:created" };
		const authority = {
			lease,
			page,
			operation_id: "operation:create-page",
			command_sequence: control.next_command_sequence,
		};
		const invoke = vi.fn().mockResolvedValue(
			reply(
				{
					control,
					response: {
						success: true,
						data: { page: created, tabId: "native:unrelated" },
					},
					observation: null,
				},
				authority.operation_id,
			),
		);
		const result = await createDureBrowserClient(route, invoke).action(
			lease.controller_id,
			authority,
			{ kind: "new_page", url: "about:blank" },
		);
		expect(result.createdPage).toEqual(created);
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it.each([
		undefined,
		page,
		{
			...page,
			page_id: "page:created",
			resource: { ...resource, generation: "generation:other" },
		},
	])(
		"rejects an uncorrelated created-page identity %j without retrying",
		async (created) => {
			const authority = {
				lease,
				page,
				operation_id: "operation:create-page",
				command_sequence: control.next_command_sequence,
			};
			const invoke = vi.fn().mockResolvedValue(
				reply(
					{
						control,
						response: {
							success: true,
							data: { page: created, targetId: "native:target" },
						},
						observation: null,
					},
					authority.operation_id,
				),
			);
			await expect(
				createDureBrowserClient(route, invoke).action(
					lease.controller_id,
					authority,
					{ kind: "new_page", url: "about:blank" },
				),
			).rejects.toMatchObject({ code: "browser_desktop_response_invalid" });
			expect(invoke).toHaveBeenCalledTimes(1);
		},
	);

	it("uses one exact backend route and preserves all wide counters", async () => {
		const invoke = vi.fn().mockResolvedValue(reply(observation));
		const observed = await createDureBrowserClient(route, invoke).observe(
			resource,
		);
		expect(observed).toEqual(observation);
		expect(invoke).toHaveBeenCalledExactlyOnceWith("dure_backend_request", {
			route: { kind: "exact", authority: route },
			operation: "browser.resource",
			body: { kind: "observe", resource_id: resource.resource_id },
		});
	});

	it("rejects a same-named resource from a replacement generation", async () => {
		const replaced = { ...resource, generation: "generation:replacement" };
		const invoke = vi
			.fn()
			.mockResolvedValue(
				reply({ ...control, resource: replaced, controller: null }),
			);
		await expect(
			createDureBrowserClient(route, invoke).control(resource),
		).rejects.toMatchObject({ code: "browser_desktop_response_invalid" });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("rejects a changed backend route without retrying or selecting another profile", async () => {
		const replaced = { ...route, revision: `sha256:${"b".repeat(64)}` };
		const invoke = vi
			.fn()
			.mockResolvedValue(
				envelope({ schemaVersion: 1, result: observation }, replaced),
			);
		await expect(
			createDureBrowserClient(route, invoke).observe(resource),
		).rejects.toMatchObject({ code: "browser_backend_changed" });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("keeps a requested handoff pending until the Host actually grants it", async () => {
		const pending = {
			...control,
			requested_controller: "controller:human",
			in_flight: "operation:agent",
		};
		const invoke = vi
			.fn()
			.mockResolvedValue(reply(pending, "operation:handoff"));
		const result = await createDureBrowserClient(route, invoke).requestControl(
			resource,
			"controller:human",
			lease,
			"operation:handoff",
		);
		expect(result.controller).toEqual(lease);
		expect(result.requested_controller).toBe("controller:human");
		expect(invoke.mock.calls[0][1].body).toEqual({
			kind: "control",
			resource,
			controller_id: "controller:human",
			expected: lease,
			operation_id: "operation:handoff",
		});
	});

	it("submits held-key release with the observed lease and leaves handoff admission to the Host", async () => {
		const authority = {
			lease,
			page,
			operation_id: "operation:release",
			command_sequence: control.next_command_sequence,
		};
		const granted = {
			...control,
			controller: {
				...lease,
				controller_id: "controller:human",
				epoch: "9007199254740996",
			},
		};
		const invoke = vi.fn().mockResolvedValue(
			reply(
				{
					response: { success: true, data: {} },
					control: granted,
					observation: null,
				},
				authority.operation_id,
			),
		);
		const action = { kind: "key_up", key: "Control" } as const;
		const result = await createDureBrowserClient(route, invoke).action(
			lease.controller_id,
			authority,
			action,
		);
		expect(result.control.controller).toEqual(granted.controller);
		expect(result.observation).toBeNull();
		expect(invoke.mock.calls[0][1].body).toEqual({
			kind: "action",
			caller: lease.controller_id,
			authority,
			action,
		});
	});

	it("never repeats input after response loss", async () => {
		const invoke = vi.fn().mockRejectedValue({
			code: "browser_outcome_unknown",
			message: "Outcome unknown",
		});
		const authority = {
			lease,
			page,
			operation_id: "operation:input",
			command_sequence: control.next_command_sequence,
		};
		await expect(
			createDureBrowserClient(route, invoke).action(
				lease.controller_id,
				authority,
				{ kind: "insert_text", text: "한글" },
			),
		).rejects.toMatchObject({ code: "browser_outcome_unknown" });
		expect(invoke).toHaveBeenCalledTimes(1);
	});

	it("rejects a screenshot of an older document before it can be painted", async () => {
		const invoke = vi.fn().mockResolvedValue(
			reply({
				page: { ...page, document_revision: "9007199254740992" },
				mimeType: "image/png",
				base64: "aW1hZ2U=",
			}),
		);
		await expect(
			createDureBrowserClient(route, invoke).screenshot(page),
		).rejects.toMatchObject({ code: "browser_desktop_response_invalid" });
	});

	it("keeps an absent receipt distinguishable from a completed input", async () => {
		const missing = {
			schemaVersion: 1,
			receipt: null,
			result_available: false,
			result: null,
		};
		const invoke = vi.fn().mockResolvedValue(envelope(missing));
		expect(
			await createDureBrowserClient(route, invoke).receipt("operation:missing"),
		).toEqual(missing);
	});

	it("rejects an action receipt belonging to a different operation", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue(
				reply(
					{ response: { success: true }, control, observation },
					"operation:other",
				),
			);
		const authority = {
			lease,
			page,
			operation_id: "operation:expected",
			command_sequence: control.next_command_sequence,
		};
		await expect(
			createDureBrowserClient(route, invoke).action(
				lease.controller_id,
				authority,
				{ kind: "reload" },
			),
		).rejects.toMatchObject({ code: "browser_desktop_response_invalid" });
	});
});

describe("Browser wire projections", () => {
	it("retains the exact current target and accepts older controls without one", () => {
		const selected = { ...control, current_page: page };
		expect(parseBrowserControl(selected)).toEqual(selected);
		expect(parseBrowserControl(control)).toEqual(control);
		expect(
			parseBrowserObservation({ ...observation, control: selected }),
		).toEqual({ ...observation, control: selected });
	});
	it("rejects malformed current targets without dropping their identity", () => {
		for (const current of [
			{ ...page, document_revision: "01" },
			{ ...page, document_revision: "18446744073709551616" },
			...Object.keys(resource).map((key) => ({
				...page,
				resource: { ...resource, [key]: "other" },
			})),
		]) {
			expect(
				parseBrowserControl({ ...control, current_page: current }),
			).toBeUndefined();
		}
	});
	it.each(["0", "01", "18446744073709551616", 9007199254740992])(
		"rejects a lossy or noncanonical counter %s",
		(revision) => {
			expect(parseBrowserControl({ ...control, revision })).toBeUndefined();
		},
	);
	it("retains simultaneous mouse, keyboard and touch contacts during a pending handoff", () => {
		const held = {
			...control,
			requested_controller: "controller:human",
			pointer: { page, buttons: 1 },
			keyboard: { page, keys: ["ControlRight", "한"] },
			touch: { page },
		};
		expect(parseBrowserControl(held)).toEqual(held);
	});
	it("rejects malformed or foreign held-touch identities", () => {
		for (const touch of [
			null,
			{},
			{ page: { ...page, document_revision: "0" } },
			{ page: { ...page, resource: { ...resource, generation: "peer" } } },
		]) {
			expect(parseBrowserControl({ ...control, touch })).toBeUndefined();
		}
	});
	it("rejects contacts and page rows belonging to another workspace", () => {
		const foreign = {
			...page,
			resource: { ...resource, workspace_id: "workspace:other" },
		};
		expect(
			parseBrowserControl({
				...control,
				pointer: { page: foreign, buttons: 1 },
			}),
		).toBeUndefined();
		expect(
			parseBrowserObservation({
				...observation,
				pages: [{ ...observation.pages[0], page: foreign }],
			}),
		).toBeUndefined();
	});
	it("preserves an observation failure with its current control projection", () => {
		const failed = {
			control: { ...control, phase: "outcome_unknown" },
			pages: [],
			observation_error: "browser_outcome_unknown",
		};
		expect(parseBrowserObservation(failed)).toEqual(failed);
	});
});

it("retains the authoritative screenshot viewport for element cropping", async () => {
	const captured = {
		page,
		mimeType: "image/png",
		base64: "aW1hZ2U=",
		viewport: { width: 640, height: 480, pixel_ratio: 2 },
	};
	const invoke = vi.fn().mockResolvedValue(reply(captured));
	expect(await createDureBrowserClient(route, invoke).screenshot(page)).toEqual(
		captured,
	);
});

it("captures once and reads the correlated immutable export through the same backend route", async () => {
	const bytes = Buffer.alloc(70_000, 23);
	const artifact = {
		page,
		mimeType: "image/png",
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const viewport = { width: 1280, height: 720, pixel_ratio: 2 };
	const invoke = vi.fn(
		async (_command: string, args?: Record<string, unknown>) => {
			const body = args?.body as {
				kind: string;
				offset: number;
				operation_id: string;
			};
			expect(args?.route).toEqual({ kind: "exact", authority: route });
			expect(body.operation_id).toBe("operation:capture");
			if (body.kind === "capture")
				return reply({ artifact, viewport }, body.operation_id);
			expect(body.kind).toBe("artifact");
			return envelope({
				schemaVersion: 1,
				artifact,
				offset: body.offset,
				base64: bytes
					.subarray(body.offset, body.offset + 65536)
					.toString("base64"),
				eof: body.offset + 65536 >= bytes.length,
			});
		},
	);
	const result = await createDureBrowserClient(route, invoke).capture(
		page,
		"operation:capture",
	);
	expect(result).toEqual({
		page,
		mimeType: "image/png",
		viewport,
		base64: bytes.toString("base64"),
	});
	expect(invoke).toHaveBeenCalledTimes(3);
	expect(invoke.mock.calls[0][1]?.body).toEqual({
		kind: "capture",
		page,
		options: { full_page: false, format: "png" },
		operation_id: "operation:capture",
	});
});

describe("Browser saved profile catalog mutations", () => {
	const saved = {
		profile: {
			profileId: "profile:new",
			label: "새 프로필",
			scope: "isolated",
			userAgentMode: "native",
		},
		state: "active",
	};
	const operation = "operation:catalog";
	it("creates a profile on the exact route with the caller's operation and policy", async () => {
		const invoke = vi
			.fn()
			.mockResolvedValue(reply({ profile: saved }, operation));
		const result = await createDureBrowserClient(route, invoke).createProfile(
			saved.profile.label,
			"native",
			operation,
		);
		expect(result).toEqual(saved);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke.mock.calls[0][1].body).toEqual({
			kind: "profile_create",
			operation_id: operation,
			label: saved.profile.label,
			scope: "isolated",
			user_agent_mode: "native",
		});
	});
	it.each(["label", "scope", "mode", "state"] as const)(
		"rejects a creation reply with mismatched %s",
		async (fault) => {
			const changed = { ...saved, profile: { ...saved.profile } };
			if (fault === "label") changed.profile.label = "different";
			if (fault === "scope") changed.profile.scope = "imported";
			if (fault === "mode") changed.profile.userAgentMode = "clean";
			if (fault === "state") changed.state = "retiring";
			const invoke = vi
				.fn()
				.mockResolvedValue(reply({ profile: changed }, operation));
			await expect(
				createDureBrowserClient(route, invoke).createProfile(
					saved.profile.label,
					"native",
					operation,
				),
			).rejects.toThrow();
			expect(invoke).toHaveBeenCalledTimes(1);
		},
	);
	it.each([true, false])(
		"preserves the canonical deletion result %s for the exact target",
		async (deleted) => {
			const invoke = vi
				.fn()
				.mockResolvedValue(
					reply({ profile_id: "profile:new", deleted }, operation),
				);
			await expect(
				createDureBrowserClient(route, invoke).deleteProfile(
					"profile:new",
					operation,
				),
			).resolves.toBe(deleted);
			expect(invoke.mock.calls[0][1].body).toEqual({
				kind: "profile_delete",
				profile_id: "profile:new",
				operation_id: operation,
			});
		},
	);
	it.each([
		{ profile_id: "profile:other", deleted: true },
		{ profile_id: "profile:new", deleted: "true" },
	])("rejects malformed deletion evidence %j", async (result) => {
		const invoke = vi.fn().mockResolvedValue(reply(result, operation));
		await expect(
			createDureBrowserClient(route, invoke).deleteProfile(
				"profile:new",
				operation,
			),
		).rejects.toThrow();
	});
	it("protects default and invalid inputs before contact and sends lost mutations only once", async () => {
		const invoke = vi.fn().mockRejectedValue(new Error("response lost"));
		const client = createDureBrowserClient(route, invoke);
		await expect(client.deleteProfile("default", operation)).rejects.toThrow();
		await expect(
			client.deleteProfile("invalid id", operation),
		).rejects.toThrow();
		await expect(
			client.createProfile("", "native", operation),
		).rejects.toThrow();
		await expect(
			client.createProfile("bad\nlabel", "native", operation),
		).rejects.toThrow();
		expect(invoke).not.toHaveBeenCalled();
		await expect(
			client.createProfile("New", "clean", operation),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledTimes(1);
		await expect(
			client.deleteProfile("profile:new", operation),
		).rejects.toThrow();
		expect(invoke).toHaveBeenCalledTimes(2);
	});
});
