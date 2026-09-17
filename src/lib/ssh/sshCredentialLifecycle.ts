import { nanoid } from "nanoid";
import { sameSshHostOperationalIdentity } from "@/lib/agents/resourceOperationalIdentity";
import type { RemoteShellHostDraft } from "@/lib/hmux/remote/remoteHmuxShellRegistration";
import { matchingRemoteHmuxHosts } from "@/lib/hmux/remote/remoteHmuxShellRequest";
import { t } from "@/lib/i18n";
import { sshSecretCopy, sshSecretSet } from "@/lib/ipc";
import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import {
	findRegisteredHost,
	sshConfigHostId,
} from "@/lib/ssh/sshConfigRegistration";
import {
	sameSshCredentialClaim,
	sshHostCredentialClaim,
	sshHostSecretId,
} from "@/lib/ssh/sshCredentialClaim";
import { withSshCredentialLifecycle } from "@/lib/ssh/sshCredentialLifecycleCoordinator";
import type { SshCredentialCleanupReport } from "@/lib/ssh/sshCredentialRegistry";
import {
	activateSshCredentialClaims,
	reconcileSshCredentialClaims,
	retireSshCredentialClaims,
	stageSshCredentialClaims,
} from "@/lib/ssh/sshCredentialRegistry";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
} from "@/store";
import type { SshCredentialClaimV1, SshHostConfig } from "@/types";

export type SshHostCredentialFields = Omit<
	SshHostConfig,
	"id" | "registrationGeneration" | "credential" | "secretId" | "password"
>;

export interface SshHostCredentialUpdate {
	readonly expected: SshHostConfig;
	readonly next: SshHostCredentialFields;
	readonly password?: string;
}

export interface SshHostRegistrationResult {
	readonly host: SshHostConfig;
	readonly created: boolean;
}

type SshHostMatch =
	| { kind: "missing" }
	| { kind: "found"; host: SshHostConfig }
	| { kind: "ambiguous" };

function newCredentialClaim(
	hostId: string,
	registrationGeneration: string,
): SshCredentialClaimV1 {
	return {
		schemaVersion: 1,
		id: `ssh-${nanoid(32)}`,
		hostId,
		registrationGeneration,
	};
}

function changedOperationalFields(update: SshHostCredentialUpdate): boolean {
	const { expected, next } = update;
	return (
		!expected.registrationGeneration ||
		expected.sshConfigAlias !== next.sshConfigAlias ||
		expected.host !== next.host ||
		expected.port !== next.port ||
		expected.user !== next.user ||
		expected.auth !== next.auth ||
		expected.keyPath !== next.keyPath ||
		Boolean(update.password) ||
		(next.auth === "password" &&
			Boolean(sshHostSecretId(expected)) &&
			!sshHostCredentialClaim(expected))
	);
}

function sameExpectedHost(
	current: SshHostConfig | undefined,
	expected: SshHostConfig,
): boolean {
	return (
		sameSshHostOperationalIdentity(current, expected) &&
		current?.name === expected.name
	);
}

function existingRegistration(
	hosts: readonly SshHostConfig[],
	next: SshHostCredentialFields,
): SshHostConfig | undefined {
	if (next.sshConfigAlias) {
		return findRegisteredHost(hosts, {
			...next,
			sshConfigAlias: next.sshConfigAlias,
		});
	}
	// Password submissions may carry a different secret; only reuse identical
	// key/automatic registrations, including across concurrent CLI and GUI adds.
	if (next.auth === "password") return undefined;
	return hosts.find(
		(host) =>
			!host.sshConfigAlias &&
			host.name === next.name &&
			host.host === next.host &&
			host.port === next.port &&
			host.user === next.user &&
			host.auth === next.auth &&
			host.keyPath === next.keyPath,
	);
}

async function stageCredentialClaim(
	expected: SshHostConfig,
	claim: SshCredentialClaimV1,
): Promise<boolean> {
	const exact = await durableAppStorage.read(
		DURABLE_APP_STORE_NAME,
		(current) => {
			if (!current) return false;
			const state = normalizePersistedState(current.state);
			return sameExpectedHost(
				state.sshHosts.find((candidate) => candidate.id === expected.id),
				expected,
			);
		},
	);
	if (!exact) return false;
	await stageSshCredentialClaims([claim]);
	return true;
}

async function commitHostSuccessor(
	update: SshHostCredentialUpdate,
	registrationGeneration: string,
	credential: SshCredentialClaimV1 | undefined,
	legacySecretId: string | undefined,
): Promise<SshHostConfig | null> {
	return durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
		if (!current) return { value: current, result: null };
		const state = normalizePersistedState(current.state);
		const hostIndex = state.sshHosts.findIndex(
			(host) => host.id === update.expected.id,
		);
		const currentHost = state.sshHosts[hostIndex];
		if (!sameExpectedHost(currentHost, update.expected)) {
			return { value: current, result: null };
		}
		const host: SshHostConfig = {
			...update.next,
			id: update.expected.id,
			registrationGeneration,
			credential,
			secretId: credential?.id ?? legacySecretId,
			password: undefined,
		};
		const sshHosts = [...state.sshHosts];
		sshHosts[hostIndex] = host;
		return {
			value: {
				version: PERSIST_VERSION,
				state: persistedSlice({
					...state,
					sshHosts,
				}),
			},
			result: host,
		};
	});
}

async function reconcileCredentialCleanupLocked(): Promise<SshCredentialCleanupReport> {
	const live = await durableAppStorage.read(
		DURABLE_APP_STORE_NAME,
		(current) => {
			if (!current) return undefined;
			const raw = current.state as unknown as { sshHosts?: unknown };
			if (!Array.isArray(raw.sshHosts)) return undefined;
			const hosts = normalizePersistedState(current.state).sshHosts;
			return {
				claims: hosts.flatMap((host) => {
					const claim = sshHostCredentialClaim(host);
					return claim ? [claim] : [];
				}),
				references: hosts.flatMap((host) => {
					const id = sshHostSecretId(host);
					return id ? [id] : [];
				}),
			};
		},
	);
	if (!live) return { deleted: [], retained: [] };
	return reconcileSshCredentialClaims(live.claims, live.references);
}

async function recoverCredentialProjectionBestEffort(): Promise<void> {
	try {
		await recoverCurrentDurableStoreProjection();
	} catch (error) {
		console.error("[ssh credential projection]", error);
	}
}

/** Deletes only durable, generation-owned claims that no Host references. */
export function reconcileSshCredentialCleanup(): Promise<SshCredentialCleanupReport> {
	return withSshCredentialLifecycle(reconcileCredentialCleanupLocked);
}

/** Creates one complete Host only after its owned credential is live. */
export function createSshHostDurably(
	next: SshHostCredentialFields,
	password?: string,
): Promise<SshHostRegistrationResult> {
	return createHostWithIdentity(next, password, (hosts, fields) => {
		const host = existingRegistration(hosts, fields);
		return host ? { kind: "found", host } : { kind: "missing" };
	});
}

/** Cross-instance retries converge in the existing durable Host transaction. */
export function registerSshLoginHostDurably(
	draft: RemoteShellHostDraft,
): Promise<SshHostRegistrationResult> {
	const next: RemoteShellHostDraft = {
		name: draft.name,
		host: draft.host,
		user: draft.user,
		port: draft.port,
		auth: "auto",
	};
	return createHostWithIdentity(next, undefined, (hosts) => {
		const matches = matchingRemoteHmuxHosts(hosts, next);
		if (matches.length > 1) return { kind: "ambiguous" };
		return matches[0]
			? { kind: "found", host: matches[0] }
			: { kind: "missing" };
	});
}

function createHostWithIdentity(
	next: SshHostCredentialFields,
	password: string | undefined,
	findExisting: (
		hosts: readonly SshHostConfig[],
		next: SshHostCredentialFields,
	) => SshHostMatch,
): Promise<SshHostRegistrationResult> {
	return withSshCredentialLifecycle(async () => {
		const existing = await durableAppStorage.read(
			DURABLE_APP_STORE_NAME,
			(current) =>
				current
					? findExisting(normalizePersistedState(current.state).sshHosts, next)
					: ({ kind: "missing" } as const),
		);
		if (existing.kind === "ambiguous") {
			throw new Error("SSH destination became ambiguous during registration");
		}
		if (existing.kind === "found") {
			await recoverCredentialProjectionBestEffort();
			return { host: existing.host, created: false };
		}

		const id = next.sshConfigAlias
			? sshConfigHostId(next.sshConfigAlias)
			: `host-${nanoid(8)}`;
		const registrationGeneration = nanoid(16);
		const credential =
			next.auth === "password"
				? newCredentialClaim(id, registrationGeneration)
				: undefined;
		if (credential) {
			if (!password) throw new Error(t("ssh.hostDialog.passwordRequired"));
			await stageSshCredentialClaims([credential]);
			await sshSecretSet(credential.id, password);
			await activateSshCredentialClaims([credential]);
		}

		const registration = await durableAppStorage.transact(
			DURABLE_APP_STORE_NAME,
			(
				current,
			): {
				value: typeof current;
				result: SshHostRegistrationResult | null;
			} => {
				const state = normalizePersistedState(current?.state ?? {});
				const selected = findExisting(state.sshHosts, next);
				if (selected.kind === "ambiguous") {
					// An expected refusal is data, not a storage-coordinator failure.
					return { value: current, result: null };
				}
				const raced =
					(selected.kind === "found" ? selected.host : undefined) ??
					state.sshHosts.find((host) => host.id === id);
				if (raced) {
					return {
						value: current,
						result: { host: raced, created: false },
					};
				}
				const host: SshHostConfig = {
					...next,
					id,
					registrationGeneration,
					credential,
					secretId: credential?.id,
					password: undefined,
				};
				return {
					value: {
						version: PERSIST_VERSION,
						state: persistedSlice({
							...state,
							sshHosts: [...state.sshHosts, host],
						}),
					},
					result: { host, created: true },
				};
			},
		);
		if (!registration?.created && credential) {
			await retireSshCredentialClaims([credential]).catch((error) => {
				console.error("[ssh credential duplicate registration]", error);
			});
		}
		if (!registration) {
			throw new Error("SSH destination became ambiguous during registration");
		}
		await recoverCredentialProjectionBestEffort();
		return registration;
	});
}

/**
 * Replaces one exact Host registration. The native claim registry owns the
 * non-transactional Keychain boundary across WebViews and app processes.
 */
export function updateSshHostCredentialsDurably(
	update: SshHostCredentialUpdate,
): Promise<SshHostConfig> {
	return withSshCredentialLifecycle(async () => {
		const operationalChange = changedOperationalFields(update);
		const predecessor = sshHostCredentialClaim(update.expected);
		const registrationGeneration = operationalChange
			? nanoid(16)
			: (update.expected.registrationGeneration ?? nanoid(16));
		const sourceSecretId = sshHostSecretId(update.expected);
		let credential = operationalChange
			? undefined
			: sshHostCredentialClaim(update.expected);
		let legacySecretId = operationalChange
			? undefined
			: update.expected.secretId;

		if (update.next.auth === "password" && operationalChange) {
			credential = newCredentialClaim(
				update.expected.id,
				registrationGeneration,
			);
			const staged = await stageCredentialClaim(update.expected, credential);
			if (!staged) {
				await recoverCredentialProjectionBestEffort();
				throw new Error(t("ssh.hostDialog.changedDuringSave"));
			}
			const password = update.password || update.expected.password;
			if (password) await sshSecretSet(credential.id, password);
			else if (sourceSecretId) {
				await sshSecretCopy(sourceSecretId, credential.id);
			} else {
				throw new Error(t("ssh.hostDialog.passwordRequired"));
			}
		}

		if (update.next.auth !== "password") {
			credential = undefined;
			legacySecretId = undefined;
		}
		if (credential && !sameSshCredentialClaim(credential, predecessor)) {
			await activateSshCredentialClaims([credential]);
		}
		const committed = await commitHostSuccessor(
			update,
			registrationGeneration,
			credential,
			legacySecretId,
		);
		if (!committed) {
			if (credential && !sameSshCredentialClaim(credential, predecessor)) {
				await retireSshCredentialClaims([credential]).catch((error) => {
					console.error("[ssh credential rollback]", error);
				});
			}
			await recoverCredentialProjectionBestEffort();
			throw new Error(t("ssh.hostDialog.changedDuringSave"));
		}
		if (
			predecessor &&
			!sameSshCredentialClaim(predecessor, committed.credential)
		) {
			await retireSshCredentialClaims([predecessor]).catch((error) => {
				console.error("[ssh credential retirement]", error);
			});
		}

		await recoverCredentialProjectionBestEffort();
		return committed;
	});
}

/** Migrates legacy credential references through the same lifecycle authority. */
export async function migrateLegacySshCredentials(): Promise<void> {
	const hosts = await withSshCredentialLifecycle(() =>
		durableAppStorage.read(DURABLE_APP_STORE_NAME, (current) =>
			current
				? normalizePersistedState(current.state).sshHosts.filter(
						(host) =>
							Boolean(host.password) ||
							(host.auth === "password" &&
								Boolean(sshHostSecretId(host)) &&
								!sshHostCredentialClaim(host)),
					)
				: [],
		),
	);
	const failures: string[] = [];
	for (const host of hosts) {
		try {
			await updateSshHostCredentialsDurably({
				expected: host,
				next: {
					name: host.name,
					sshConfigAlias: host.sshConfigAlias,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: host.auth,
					keyPath: host.keyPath,
				},
				password: host.password,
			});
		} catch (error) {
			failures.push(`${host.name}: ${String(error)}`);
		}
	}
	if (failures.length > 0) throw new Error(failures.join("\n"));
}

/** Registers live Host references and collects work from prior app processes. */
export async function initializeSshCredentialLifecycle(): Promise<void> {
	await reconcileSshCredentialCleanup();
	await migrateLegacySshCredentials();
}
