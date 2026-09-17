import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";

export interface QaLocalProject {
	ready: true;
	projectId: string;
	path: string;
}

export function qaLocalProjectPath(flag: string): string | undefined {
	const path = flag
		.match(/^localproject=(.+)$/mu)?.[1]
		?.trim()
		.replace(/\/+$/u, "");
	return path || undefined;
}

/** Register one real local project for an isolated DEV app and make it durable
 * before a WebView reload can exercise boot recovery. */
export async function ensureQaLocalProject(
	path: string,
): Promise<QaLocalProject> {
	const normalized = path.trim().replace(/\/+$/u, "");
	if (!normalized) throw new Error("QA local project path is empty");
	const project = await useStore.getState().ensureProjectForPath(normalized);
	await durableAppStorage.reconcile(DURABLE_APP_STORE_NAME);
	return { ready: true, projectId: project.id, path: project.path };
}

export async function runQaLocalProjectFlag(
	flag: string,
	log: (...args: unknown[]) => void,
): Promise<void> {
	const path = qaLocalProjectPath(flag);
	if (!path) return;
	log("qa-local-project", await ensureQaLocalProject(path));
}
