import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { resolveCliSpaceId } from "@/lib/cli/cliSpaceIdentity";
import { useStore } from "@/store";
import type { Project, Space } from "@/types";

export interface CliProjectRegistrationDependencies {
	isMainWindow(): boolean;
	claim(reqId: string): Promise<boolean>;
	state(): {
		activeSpaceId: string;
		spaces: Space[];
		addLocalProject(path: string): Promise<Project>;
		addRemoteProject(hostId: string, path: string): Promise<Project>;
	};
}

const dependencies: CliProjectRegistrationDependencies = {
	isMainWindow: () => getCurrentWebviewWindow().label === "main",
	claim: claimCliRequest,
	state: () => useStore.getState(),
};

function requestText(value: unknown, field: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > maximum ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	) {
		throw Object.assign(
			new Error(`${field} must be a nonempty bounded string`),
			{
				code: "invalid_request",
			},
		);
	}
	return value;
}

/** Project locations are app-wide. The main store uses the same GUI add
 * actions; Space is request context, never a new membership or pane action. */
export async function handleCliProjectRegistration(
	params: Record<string, unknown>,
	reqId: string,
	deps: CliProjectRegistrationDependencies = dependencies,
) {
	if (!deps.isMainWindow() || !(await deps.claim(reqId))) return null;
	try {
		const path = requestText(params.path, "path", 4096);
		const hostId = requestText(params.hostId ?? "local", "hostId", 512).trim();
		const state = deps.state();
		const spaceId = resolveCliSpaceId(params) ?? state.activeSpaceId;
		if (!state.spaces.some((space) => space.id === spaceId)) {
			throw Object.assign(new Error(`Space ${spaceId} was not found`), {
				code: "client_space_not_found",
			});
		}
		const project =
			hostId === "local"
				? await state.addLocalProject(path)
				: await state.addRemoteProject(hostId, path);
		return {
			ok: true,
			registration: { project, spaceId, hostId, scope: "app", persisted: true },
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code:
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "project_add_failed",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}
