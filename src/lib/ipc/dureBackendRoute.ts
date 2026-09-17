import {
	type BackendPresentationTarget,
	parseBackendPresentationTarget,
	resolveBackendPresentationSshHost,
} from "@/lib/cli/backendPresentationTarget";
import {
	isDureBackendProfileIdV1,
	isDureWireTokenV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { asRecord as record } from "@/lib/payloadGuards";
import type { Project, SshHostConfig } from "@/types";

const REVISION = /^sha256:[0-9a-f]{64}$/;

export interface DureBackendRouteAuthorityV1 {
	readonly schemaVersion: 1;
	readonly profileId: string;
	readonly revision: string;
	readonly backend: { readonly id: string; readonly generation: string };
	readonly target: BackendPresentationTarget;
}

export type DureBackendRouteV1 =
	| { readonly kind: "selected"; readonly profileId?: string }
	| { readonly kind: "exact"; readonly authority: DureBackendRouteAuthorityV1 };

type RouteFailure = (code: string, message: string) => never;

export function selectedDureBackendRoute(
	profileId?: string,
): DureBackendRouteV1 {
	return profileId === undefined
		? { kind: "selected" }
		: { kind: "selected", profileId };
}

export function exactDureBackendRoute(
	authority: DureBackendRouteAuthorityV1,
): DureBackendRouteV1 {
	return { kind: "exact", authority };
}

export function parseDureBackendRouteAuthority(
	value: unknown,
): DureBackendRouteAuthorityV1 | undefined {
	const authority = record(value);
	const backend = record(authority?.backend);
	const rawTarget = record(authority?.target);
	if (
		!authority ||
		!backend ||
		!rawTarget ||
		authority.schemaVersion !== 1 ||
		!isDureBackendProfileIdV1(authority.profileId) ||
		typeof authority.revision !== "string" ||
		!REVISION.test(authority.revision) ||
		!isDureWireTokenV1(backend.id) ||
		!isDureWireTokenV1(backend.generation)
	) {
		return undefined;
	}
	let target: BackendPresentationTarget;
	try {
		target = parseBackendPresentationTarget(rawTarget, () => {
			throw new Error("invalid backend presentation target");
		});
	} catch {
		return undefined;
	}
	return {
		schemaVersion: 1,
		profileId: authority.profileId,
		revision: authority.revision,
		backend: { id: backend.id, generation: backend.generation },
		target,
	};
}

export function sameDureBackendRouteAuthority(
	left: DureBackendRouteAuthorityV1,
	right: DureBackendRouteAuthorityV1,
): boolean {
	return (
		left.profileId === right.profileId &&
		left.revision === right.revision &&
		left.backend.id === right.backend.id &&
		left.backend.generation === right.backend.generation &&
		sameDureBackendRouteTarget(left.target, right.target)
	);
}

export function sameDureBackendRouteTarget(
	left: BackendPresentationTarget,
	right: BackendPresentationTarget,
): boolean {
	return (
		left.source === right.source &&
		(left.source === "local" ||
			(right.source === "ssh" &&
				left.hostId === right.hostId &&
				left.remote.host === right.remote.host &&
				left.remote.port === right.remote.port &&
				left.remote.user === right.remote.user))
	);
}

/** Resolves one exact or uniquely coordinate-matched registered SSH host from
 * the parsed backend route. */
export function resolveDureBackendSshHost(
	authority: DureBackendRouteAuthorityV1,
	hosts: readonly SshHostConfig[],
	fail: RouteFailure,
): SshHostConfig {
	if (authority.target.source !== "ssh") {
		return fail(
			"client_backend_host_mismatch",
			"local backend route cannot target an SSH project",
		);
	}
	return resolveBackendPresentationSshHost(authority.target, hosts, fail);
}

/** Resolves profile coordinates to one registered host, then proves that host
 * is the project target before callers start an SSH preflight or overlay. */
export function resolveExactDureBackendSshHost(
	authority: DureBackendRouteAuthorityV1,
	projectHostId: string,
	hosts: readonly SshHostConfig[],
	fail: RouteFailure,
): SshHostConfig {
	const host = resolveDureBackendSshHost(authority, hosts, fail);
	if (host.id !== projectHostId) {
		return fail(
			"client_backend_host_mismatch",
			"backend route and project SSH host disagree",
		);
	}
	return host;
}

/** Binds one exact backend route to the Project transport that owns the work. */
export function assertExactDureBackendProjectTarget(
	authority: DureBackendRouteAuthorityV1,
	project: Project,
	hosts: readonly SshHostConfig[],
	fail: RouteFailure,
): void {
	if (project.kind === "local") {
		if (authority.target.source !== "local") {
			fail(
				"client_backend_host_mismatch",
				"SSH backend route cannot target a local project",
			);
		}
		return;
	}
	if (!project.sshHostId) {
		fail(
			"client_backend_host_mismatch",
			"SSH project has no exact registered host",
		);
	}
	resolveExactDureBackendSshHost(authority, project.sshHostId, hosts, fail);
}
