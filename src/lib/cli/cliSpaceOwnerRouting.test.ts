import { describe, expect, it, vi } from "vitest";
import {
	type CliSpaceOwnerRoutingDependencies,
	resolveMountedSpaceOwner,
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

describe("presentation Space owner routing", () => {
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
		).resolves.toEqual({ kind: "forwarded" });
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
			resolveMountedSpaceOwner("space-target", dependencies, 20),
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
			listenResponse: async () => () => undefined,
			emitRequest: async () => undefined,
		};

		await expect(
			resolveMountedSpaceOwner("space-target", dependencies, 20),
		).resolves.toBe("main");
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
			listenResponse: async () => () => undefined,
			emitRequest: async () => undefined,
		};

		await expect(
			resolveMountedSpaceOwner("space-target", dependencies, 20),
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
			).resolves.toEqual({ kind: "forwarded" });
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
