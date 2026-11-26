import { describe, expect, it, vi } from "vitest";
import {
	type CliSpaceOwnerRoutingDependencies,
	resolveSpaceOwner,
	routeCliRequestToSpaceOwner,
	type SpaceOwnerCollector,
	type SpaceOwnerObservation,
} from "@/lib/cli/cliSpaceOwnerRouting";

function observation(
	spaceId: string,
	windowLabel: string,
	options: { mounted: boolean; active: boolean },
): SpaceOwnerObservation {
	return { spaceId, windowLabel, ...options };
}

/** Every listed window answers that it has not mounted the Space. */
function unmountedCollector(
	currentWindowLabel: string,
	windowLabels: string[],
	space: { id: string; kind?: "popout" } | undefined,
): SpaceOwnerCollector {
	let respond: (payload: unknown) => void = () => undefined;
	return {
		currentWindowLabel: () => currentWindowLabel,
		listWindowLabels: async () => windowLabels,
		readLocal: (spaceId) =>
			observation(spaceId, currentWindowLabel, {
				mounted: false,
				active: false,
			}),
		readSpace: () => space,
		listenResponse: async (listener) => {
			respond = listener;
			return () => undefined;
		},
		emitRequest: async (windowLabel, request) => {
			respond({
				requestId: request.requestId,
				sample: observation(request.spaceId, windowLabel, {
					mounted: false,
					active: false,
				}),
			});
		},
	};
}

describe("presentation Space owner routing", () => {
	it("routes a move to its source owner without replacing its destination", async () => {
		const resolveOwner = vi.fn(async () => "win-100-2");
		const forward = vi.fn(async () => undefined);
		const request = {
			reqId: "move",
			action: "pane.move",
			params: {
				targetPanelId: "pane",
				fromSpaceId: "source",
				spaceId: "target",
			},
		};
		await routeCliRequestToSpaceOwner(request, {
			currentWindowLabel: () => "main",
			activeSpaceId: () => "unrelated",
			resolveOwner,
			forward,
		});
		expect(resolveOwner).toHaveBeenCalledWith("source");
		expect(forward).toHaveBeenCalledWith("win-100-2", {
			...request,
			params: { ...request.params, windowLabel: "win-100-2" },
		});
	});
	it("routes an omitted Space to the active Space's mounted owner", async () => {
		const forward = vi.fn(async () => undefined);
		const dependencies = {
			currentWindowLabel: () => "main",
			activeSpaceId: () => "space-active",
			resolveOwner: vi.fn(async () => "win-100-2"),
			forward,
		};
		await expect(
			routeCliRequestToSpaceOwner(
				{
					reqId: "default-space",
					action: "hmux.create",
					params: { cwd: "/plain" },
				},
				dependencies,
			),
		).resolves.toEqual({ kind: "elsewhere" });
		expect(dependencies.resolveOwner).toHaveBeenCalledWith("space-active");
		expect(forward).toHaveBeenCalledExactlyOnceWith("win-100-2", {
			reqId: "default-space",
			action: "hmux.create",
			params: {
				cwd: "/plain",
				spaceId: "space-active",
				windowLabel: "win-100-2",
			},
		});
	});
	it("selects the active mounted owner across live workspace windows", async () => {
		let respond: (payload: unknown) => void = () => undefined;
		const stop = vi.fn();
		const dependencies: SpaceOwnerCollector = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => [
				"main",
				"win-100-1",
				"win-100-2",
				"win-diff-agent",
			],
			readLocal: (spaceId) =>
				observation(spaceId, "main", {
					mounted: true,
					active: false,
				}),
			readSpace: (id) => ({ id }),
			listenResponse: async (listener) => {
				respond = listener;
				return stop;
			},
			emitRequest: async (windowLabel, request) => {
				respond({
					requestId: request.requestId,
					sample: observation(request.spaceId, windowLabel, {
						mounted: true,
						active: windowLabel === "win-100-2",
					}),
				});
			},
		};

		await expect(
			resolveSpaceOwner("space-target", dependencies, 20),
		).resolves.toBe("win-100-2");
		expect(stop).toHaveBeenCalledOnce();
	});

	it("keeps a warm local mount when no active owner exists", async () => {
		const dependencies: SpaceOwnerCollector = {
			currentWindowLabel: () => "main",
			listWindowLabels: async () => ["main"],
			readLocal: (spaceId) =>
				observation(spaceId, "main", {
					mounted: true,
					active: false,
				}),
			readSpace: (id) => ({ id }),
			listenResponse: async () => () => undefined,
			emitRequest: async () => undefined,
		};

		await expect(
			resolveSpaceOwner("space-target", dependencies, 20),
		).resolves.toBe("main");
	});

	it("gives a Space no window shows to the window that mounts it", async () => {
		// The Agent's large window cannot mount a Space, so the Space's own
		// window presents it even while the large window has the request.
		await expect(
			resolveSpaceOwner(
				"space-target",
				unmountedCollector("win-session-agent", ["main", "win-100-1"], {
					id: "space-target",
				}),
				20,
			),
		).resolves.toBe("main");
		await expect(
			resolveSpaceOwner(
				"space-target",
				unmountedCollector("win-100-1", ["main", "win-100-1"], {
					id: "space-target",
				}),
				20,
			),
		).resolves.toBe("main");
	});

	it("gives an unshown Space to another window that can mount it", async () => {
		await expect(
			resolveSpaceOwner(
				"space-target",
				unmountedCollector("win-presentation", ["win-100-2", "win-100-1"], {
					id: "space-target",
				}),
				20,
			),
		).resolves.toBe("win-100-1");
		await expect(
			resolveSpaceOwner(
				"space-popout",
				unmountedCollector(
					"main",
					["main", "win-100-1", "win-popout-space-popout"],
					{ id: "space-popout", kind: "popout" },
				),
				20,
			),
		).resolves.toBe("win-popout-space-popout");
	});

	it("leaves an unknown or unshowable Space to the receiving window", async () => {
		await expect(
			resolveSpaceOwner(
				"space-gone",
				unmountedCollector("win-session-agent", ["main"], undefined),
				20,
			),
		).resolves.toBeUndefined();
		await expect(
			resolveSpaceOwner(
				"space-popout",
				unmountedCollector("win-session-agent", ["main"], {
					id: "space-popout",
					kind: "popout",
				}),
				20,
			),
		).resolves.toBeUndefined();
	});

	it("uses an active local owner without a window census", async () => {
		const listWindowLabels = vi.fn(async () => ["main", "win-100-1"]);
		const dependencies: SpaceOwnerCollector = {
			currentWindowLabel: () => "main",
			listWindowLabels,
			readLocal: (spaceId) =>
				observation(spaceId, "main", {
					mounted: true,
					active: true,
				}),
			readSpace: (id) => ({ id }),
			listenResponse: async () => () => undefined,
			emitRequest: async () => undefined,
		};

		await expect(
			resolveSpaceOwner("space-target", dependencies, 20),
		).resolves.toBe("main");
		expect(listWindowLabels).not.toHaveBeenCalled();
	});

	it.each(["hmux.create", "pane.close"])(
		"forwards %s once and lets the target become its writer",
		async (action) => {
			const forward = vi.fn(async () => undefined);
			const dependencies: CliSpaceOwnerRoutingDependencies = {
				currentWindowLabel: () => "main",
				activeSpaceId: () => "space-active",
				resolveOwner: async () => "win-100-2",
				forward,
			};
			const params = { spaceId: "space-target", targetPanelId: "term:a" };

			await expect(
				routeCliRequestToSpaceOwner(
					{ reqId: "request-1", action, params },
					dependencies,
				),
			).resolves.toEqual({ kind: "elsewhere" });
			expect(forward).toHaveBeenCalledOnce();
			expect(forward).toHaveBeenCalledWith("win-100-2", {
				reqId: "request-1",
				action,
				params: { ...params, windowLabel: "win-100-2" },
			});
		},
	);

	it("trusts an explicitly routed target without another owner query", async () => {
		const resolveOwner = vi.fn(async () => "main");
		const dependencies: CliSpaceOwnerRoutingDependencies = {
			currentWindowLabel: () => "win-100-2",
			activeSpaceId: () => "space-active",
			resolveOwner,
			forward: vi.fn(async () => undefined),
		};

		await expect(
			routeCliRequestToSpaceOwner(
				{
					reqId: "request-2",
					action: "pane.close",
					params: {
						spaceId: "space-target",
						windowLabel: "win-100-2",
					},
				},
				dependencies,
			),
		).resolves.toEqual({ kind: "local", spaceId: "space-target" });
		expect(resolveOwner).not.toHaveBeenCalled();
	});

	it.each([
		["pane.open", { spaceId: "space-target", tool: "file", path: "/a.png" }],
		["pane.close", { targetPanelId: "term:a" }],
	])(
		"leaves %s addressed to another window to that window",
		async (action, params) => {
			// Every window receives every request; only the addressed one runs it.
			const dependencies: CliSpaceOwnerRoutingDependencies = {
				currentWindowLabel: () => "win-session-agent",
				activeSpaceId: () => "space-active",
				resolveOwner: vi.fn(async () => "main"),
				forward: vi.fn(async () => undefined),
			};

			await expect(
				routeCliRequestToSpaceOwner(
					{
						reqId: "request-3",
						action,
						params: { ...params, windowLabel: "main" },
					},
					dependencies,
				),
			).resolves.toEqual({ kind: "elsewhere" });
			expect(dependencies.resolveOwner).not.toHaveBeenCalled();
			expect(dependencies.forward).not.toHaveBeenCalled();
		},
	);

	it("does not narrow a legacy unscoped close to the active Space", async () => {
		const dependencies = {
			currentWindowLabel: () => "main",
			activeSpaceId: () => "space-active",
			resolveOwner: vi.fn(async () => "win-100-2"),
			forward: vi.fn(),
		};
		await expect(
			routeCliRequestToSpaceOwner(
				{
					reqId: "unscoped",
					action: "pane.close",
					params: { targetPanelId: "term:a" },
				},
				dependencies,
			),
		).resolves.toEqual({ kind: "local" });
		expect(dependencies.resolveOwner).not.toHaveBeenCalled();
	});
});
