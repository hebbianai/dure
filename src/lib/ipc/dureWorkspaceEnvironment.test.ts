import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import {
	createEnvironment,
	environmentRecipes,
	listEnvironments,
	transitionEnvironment,
} from "@/lib/ipc/dureWorkspaceEnvironment";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import {
	environmentActions,
	parseEnvironment,
	type WorkspaceEnvironment,
} from "@/lib/environments/workspaceEnvironmentContract";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const environment: WorkspaceEnvironment = {
	id: `env-${"a".repeat(64)}`,
	revision: 2,
	name: "Task",
	projectPath: "/repo",
	recipeId: "lima",
	recipeName: "Lima",
	status: "running",
	error: null,
	createdAtMs: 1,
	updatedAtMs: 2,
	canSuspend: true,
	connection: {
		host: "127.0.0.1",
		port: 2222,
		user: "dure",
		keyPath: null,
		projectRoot: "/home/dure/project",
	},
};
const authority = testDureBackendRouteAuthority(
	"backend-1",
	"generation-1",
	"local",
);
function respond(result: unknown) {
	vi.mocked(invoke).mockResolvedValue({
		schemaVersion: 1,
		backendId: "backend-1",
		backendGeneration: "generation-1",
		routeAuthority: authority,
		result,
	});
}
it("Basic retains cleanup while pending operations cannot be repeated", () => {
	expect(environmentActions(environment, false)).toEqual([
		"suspend",
		"destroy",
	]);
	expect(
		environmentActions({ ...environment, status: "suspended" }, false),
	).toEqual(["destroy"]);
	expect(
		environmentActions({ ...environment, status: "suspended" }, true),
	).toEqual(["resume", "destroy"]);
	expect(
		environmentActions({ ...environment, status: "destroying" }, true),
	).toEqual([]);
	expect(
		environmentActions(
			{ ...environment, status: "cleanup_failed", connection: null },
			false,
		),
	).toEqual(["destroy"]);
});
it("rejects incomplete running state and invalid connection values", () => {
	expect(parseEnvironment({ ...environment, connection: null })).toBeNull();
	expect(
		parseEnvironment({
			...environment,
			connection: { ...environment.connection, port: 0 },
		}),
	).toBeNull();
	expect(
		parseEnvironment({
			...environment,
			connection: { ...environment.connection, user: "bad user" },
		}),
	).toBeNull();
	expect(
		parseEnvironment({ ...environment, status: "creating", connection: null }),
	).not.toBeNull();
});
it("lists only on the explicit local route and rejects duplicate identities", async () => {
	respond({
		schemaVersion: 1,
		proAvailable: true,
		environments: [environment],
	});
	expect((await listEnvironments()).environments).toEqual([environment]);
	expect(invoke).toHaveBeenCalledWith(
		"dure_backend_request",
		expect.objectContaining({
			route: { kind: "selected", profileId: "local" },
		}),
	);
	respond({
		schemaVersion: 1,
		proAvailable: true,
		environments: [environment, environment],
	});
	await expect(listEnvironments()).rejects.toMatchObject({
		code: "environment_response_invalid",
	});
});
it("creation is fenced by the reviewed recipe and selected backend authority", async () => {
	const recipe = {
		id: "lima",
		name: "Local VM",
		digest: `sha256:${"b".repeat(64)}`,
		canSuspend: true,
	};
	respond({ schemaVersion: 1, proAvailable: true, recipes: [recipe] });
	const catalog = await environmentRecipes("/repo");
	respond({
		schemaVersion: 1,
		environment: { ...environment, status: "creating", connection: null },
	});
	const body = {
		projectPath: "/repo",
		recipeId: recipe.id,
		recipeDigest: recipe.digest,
		name: "Task",
		idempotencyKey: "same-retry",
	};
	await createEnvironment(body, catalog.authority);
	expect(invoke).toHaveBeenLastCalledWith("dure_backend_request", {
		route: { kind: "exact", authority },
		operation: "workspace_environment.invoke",
		body: { schemaVersion: 1, action: "create", ...body },
	});
});
it("lifecycle sends the observed revision and never retries transport failures", async () => {
	vi.mocked(invoke).mockRejectedValue(new Error("lost acknowledgement"));
	await expect(
		transitionEnvironment(environment, "destroy", authority),
	).rejects.toThrow();
	expect(invoke).toHaveBeenCalledOnce();
	expect(invoke).toHaveBeenCalledWith(
		"dure_backend_request",
		expect.objectContaining({
			body: expect.objectContaining({
				action: "transition",
				expectedRevision: 2,
				id: environment.id,
				operation: "destroy",
			}),
		}),
	);
});
