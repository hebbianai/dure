import {
	agentRemovalRegistrationIdentity,
	sameAgentRemovalProjection,
	sameAgentRemovalTarget,
} from "@/lib/agents/agentRemovalRegistration";
import { agentHostReferenceIds } from "@/lib/agents/agentHostReferences";
import {
	sameSshCredentialClaim,
	sshHostCredentialClaim,
	sshHostSecretId,
} from "@/lib/ssh/sshCredentialClaim";
import type { Agent, Project, SshHostConfig } from "@/types";

export interface RemovalObservation {
	readonly agents: readonly Agent[];
	readonly projects: readonly Project[];
	readonly sshHosts: readonly SshHostConfig[];
}

/** Ignore presentation refreshes while retaining the target observed across an await. */
export function sameObservedRemovalAgent(
	agentId: string,
	before: RemovalObservation,
	after: RemovalObservation,
	stopped = false,
): boolean {
	const expected = before.agents.find((agent) => agent.id === agentId);
	const current = after.agents.find((agent) => agent.id === agentId);
	if (!expected || !current) return expected === current;
	const matches = stopped ? sameAgentRemovalProjection : sameAgentRemovalTarget;
	if (!matches(current, agentRemovalRegistrationIdentity(expected)))
		return false;
	const expectedProject = before.projects.find(
		(project) => project.id === expected.projectId,
	);
	const currentProject = after.projects.find(
		(project) => project.id === current.projectId,
	);
	if (
		expectedProject !== currentProject &&
		!sameProjectOperationalIdentity(currentProject, expectedProject)
	)
		return false;
	const hostIds = new Set([
		...agentHostReferenceIds(expected),
		...(expectedProject?.sshHostId ? [expectedProject.sshHostId] : []),
	]);
	return [...hostIds].every((hostId) => {
		const expectedHost = before.sshHosts.find((host) => host.id === hostId);
		const currentHost = after.sshHosts.find((host) => host.id === hostId);
		return (
			expectedHost === currentHost ||
			sameSshHostOperationalIdentity(currentHost, expectedHost)
		);
	});
}

/** Fields that decide whether an Agent still denotes the same registration. */
export function sameAgentOperationalIdentity(
	current: Agent | undefined,
	expected: Agent | undefined,
): boolean {
	return Boolean(
		current &&
			expected &&
			sameAgentRemovalProjection(
				current,
				agentRemovalRegistrationIdentity(expected),
			),
	);
}

/** Fields that decide whether a Project still denotes the prepared resource. */
export function sameProjectOperationalIdentity(
	current: Project | undefined,
	expected: Project | undefined,
): boolean {
	return Boolean(
		current &&
			expected &&
			current.id === expected.id &&
			current.kind === expected.kind &&
			current.path === expected.path &&
			current.sshHostId === expected.sshHostId,
	);
}

/** Fields that decide whether an SSH host still denotes the prepared target. */
export function sameSshHostOperationalIdentity(
	current: SshHostConfig | undefined,
	expected: SshHostConfig | undefined,
): boolean {
	return Boolean(
		current &&
			expected &&
			current.id === expected.id &&
			current.registrationGeneration === expected.registrationGeneration &&
			current.sshConfigAlias === expected.sshConfigAlias &&
			current.host === expected.host &&
			current.port === expected.port &&
			current.user === expected.user &&
			current.auth === expected.auth &&
			sameSshCredentialClaim(
				sshHostCredentialClaim(current),
				sshHostCredentialClaim(expected),
			) &&
			sshHostSecretId(current) === sshHostSecretId(expected) &&
			current.password === expected.password &&
			current.keyPath === expected.keyPath,
	);
}

/** Exact persisted pane identity used once at a destructive transaction boundary. */
export function samePaneOperationalIdentity(
	current: unknown,
	expected: unknown,
): boolean {
	if (Object.is(current, expected)) return true;
	if (
		current === null ||
		expected === null ||
		typeof current !== "object" ||
		typeof expected !== "object" ||
		Array.isArray(current) !== Array.isArray(expected)
	) {
		return false;
	}
	if (Array.isArray(current) && Array.isArray(expected)) {
		return (
			current.length === expected.length &&
			current.every((value, index) =>
				samePaneOperationalIdentity(value, expected[index]),
			)
		);
	}
	const currentRecord = current as Readonly<Record<string, unknown>>;
	const expectedRecord = expected as Readonly<Record<string, unknown>>;
	const currentKeys = Object.keys(currentRecord).sort();
	const expectedKeys = Object.keys(expectedRecord).sort();
	return (
		currentKeys.length === expectedKeys.length &&
		currentKeys.every(
			(key, index) =>
				key === expectedKeys[index] &&
				samePaneOperationalIdentity(currentRecord[key], expectedRecord[key]),
		)
	);
}
