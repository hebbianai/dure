import { type QaSshFixture, qaSshFixture } from "@/lib/qa/qaSshFixture";
import { createSshHostDurably } from "@/lib/ssh/sshCredentialLifecycle";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";

type QaLogger = (...args: unknown[]) => void;

export interface QaSshProject {
	ready: true;
	hostId: string;
	projectId: string;
	path: string;
}

function fixtureAlias(fixture: QaSshFixture): string {
	return `dure-qa:${fixture.user}@${fixture.host}:${fixture.port}`;
}

/** Register the SSH endpoint and project through their normal durable owners. */
export async function ensureQaSshProject(
	fixture: QaSshFixture,
): Promise<QaSshProject> {
	const registration = await createSshHostDurably({
		name: fixture.name,
		sshConfigAlias: fixtureAlias(fixture),
		host: fixture.host,
		port: fixture.port,
		user: fixture.user,
		auth: "key",
		keyPath: fixture.keyPath,
	});
	const project = await useStore
		.getState()
		.ensureProjectForPath(fixture.expectedWorkspacePath, registration.host.id);
	await durableAppStorage.reconcile(DURABLE_APP_STORE_NAME);
	return {
		ready: true,
		hostId: registration.host.id,
		projectId: project.id,
		path: project.path,
	};
}

export async function runQaSshProjectFlag(
	flag: string,
	log: QaLogger,
): Promise<void> {
	const fixture = qaSshFixture(flag, "sshproject");
	if (!fixture) return;
	log("qa-ssh-project", await ensureQaSshProject(fixture));
}
