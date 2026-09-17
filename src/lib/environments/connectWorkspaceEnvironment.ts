import { createSshHostDurably } from "@/lib/ssh/sshCredentialLifecycle";
import { useStore } from "@/store";
import type { Project } from "@/types";
import type { WorkspaceEnvironment } from "./workspaceEnvironmentContract";

/** Reuse canonical SSH registration and project inspection, including host-key trust. */
export async function connectWorkspaceEnvironment(
	environment: WorkspaceEnvironment,
): Promise<Project> {
	if (environment.status !== "running" || !environment.connection)
		throw new Error("environment_not_running");
	const connection = environment.connection;
	const { host } = await createSshHostDurably({
		name: environment.name,
		host: connection.host,
		port: connection.port,
		user: connection.user,
		auth: connection.keyPath ? "key" : "auto",
		...(connection.keyPath ? { keyPath: connection.keyPath } : {}),
	});
	return useStore
		.getState()
		.ensureProjectForPath(connection.projectRoot, host.id);
}
