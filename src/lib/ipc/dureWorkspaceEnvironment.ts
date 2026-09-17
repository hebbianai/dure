import {
	type EnvironmentOperation,
	type EnvironmentRecipe,
	parseEnvironment,
	parseEnvironmentRecipe,
	type WorkspaceEnvironment,
} from "@/lib/environments/workspaceEnvironmentContract";
import { t } from "@/lib/i18n";
import {
	createDureBackendRequester,
	DureBackendRequestError,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export interface EnvironmentSnapshot {
	authority: DureBackendRouteAuthorityV1;
	proAvailable: boolean;
	environments: WorkspaceEnvironment[];
}
export interface RecipeSnapshot {
	authority: DureBackendRouteAuthorityV1;
	proAvailable: boolean;
	recipes: EnvironmentRecipe[];
}
export interface CreateEnvironmentRequest {
	projectPath: string;
	recipeId: string;
	recipeDigest: string;
	name: string;
	idempotencyKey: string;
}
function invalid(): never {
	throw new DureBackendRequestError(
		"environment_response_invalid",
		t("environments.failed"),
		{ kind: "contract" },
	);
}
async function invoke(
	body: Record<string, unknown>,
	authority?: DureBackendRouteAuthorityV1,
) {
	const request = createDureBackendRequester({
		profileId: "local",
		invalidResponseCode: "environment_response_invalid",
		invalidResponseMessage: "environments.failed",
		backendChangedCode: "environment_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "environment_request_failed",
		requestFailedMessage: "environments.failed",
	});
	const response = await request(
		"workspace_environment.invoke",
		{ schemaVersion: 1, ...body },
		authority
			? { kind: "exact", authority }
			: { kind: "complete_selected_snapshot" },
	);
	if (
		response.routeAuthority.profileId !== "local" ||
		response.routeAuthority.target.source !== "local"
	)
		invalid();
	return response;
}
export async function listEnvironments(): Promise<EnvironmentSnapshot> {
	const { result, routeAuthority } = await invoke({ action: "list" });
	if (
		typeof result.proAvailable !== "boolean" ||
		!Array.isArray(result.environments)
	)
		invalid();
	const environments = result.environments.map(
		(value) => parseEnvironment(value) ?? invalid(),
	);
	if (
		new Set(environments.map((environment) => environment.id)).size !==
		environments.length
	)
		invalid();
	return {
		authority: routeAuthority,
		proAvailable: result.proAvailable,
		environments,
	};
}
export async function environmentRecipes(
	projectPath: string,
): Promise<RecipeSnapshot> {
	const { result, routeAuthority } = await invoke({
		action: "recipes",
		projectPath,
	});
	if (
		typeof result.proAvailable !== "boolean" ||
		!Array.isArray(result.recipes)
	)
		invalid();
	const recipes = result.recipes.map(
		(value) => parseEnvironmentRecipe(value) ?? invalid(),
	);
	if (new Set(recipes.map((recipe) => recipe.id)).size !== recipes.length)
		invalid();
	return {
		authority: routeAuthority,
		proAvailable: result.proAvailable,
		recipes,
	};
}
export async function createEnvironment(
	body: CreateEnvironmentRequest,
	authority: DureBackendRouteAuthorityV1,
): Promise<WorkspaceEnvironment> {
	const { result } = await invoke({ action: "create", ...body }, authority);
	return parseEnvironment(result.environment) ?? invalid();
}
export async function transitionEnvironment(
	environment: WorkspaceEnvironment,
	operation: EnvironmentOperation,
	authority: DureBackendRouteAuthorityV1,
): Promise<WorkspaceEnvironment> {
	const { result } = await invoke(
		{
			action: "transition",
			id: environment.id,
			expectedRevision: environment.revision,
			operation,
			idempotencyKey: crypto.randomUUID(),
		},
		authority,
	);
	return parseEnvironment(result.environment) ?? invalid();
}
