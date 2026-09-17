// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeAgentProjectionDurably } from "@/lib/agents/durableAgentRemoval";

const mocks = vi.hoisted(() => ({
	recoverCurrentDurableStoreProjection: vi.fn(),
	sshCredentialClaimActivate: vi.fn(),
	sshCredentialClaimReconcile: vi.fn(),
	sshCredentialClaimRetire: vi.fn(),
	sshCredentialClaimStage: vi.fn(),
	sshSecretCopy: vi.fn(),
	sshSecretSet: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	sshCredentialClaimActivate: mocks.sshCredentialClaimActivate,
	sshCredentialClaimReconcile: mocks.sshCredentialClaimReconcile,
	sshCredentialClaimRetire: mocks.sshCredentialClaimRetire,
	sshCredentialClaimStage: mocks.sshCredentialClaimStage,
	sshSecretCopy: mocks.sshSecretCopy,
	sshSecretSet: mocks.sshSecretSet,
}));

vi.mock("@/lib/persistence/currentDurableProjectionRecovery", () => ({
	recoverCurrentDurableStoreProjection:
		mocks.recoverCurrentDurableStoreProjection,
}));

import {
	normalizePersistedState,
	persistedSlice,
} from "@/lib/persistence/persistedAppState";
import { sshConfigHostId } from "@/lib/ssh/sshConfigRegistration";
import {
	createSshHostDurably,
	migrateLegacySshCredentials,
	reconcileSshCredentialCleanup,
	registerSshLoginHostDurably,
	updateSshHostCredentialsDurably,
} from "@/lib/ssh/sshCredentialLifecycle";
import {
	DURABLE_APP_STORE_NAME,
	durableAppStorage,
	PERSIST_VERSION,
	rehydrateAppStoreFromDurableStorage,
	useStore,
} from "@/store";
import type { SshCredentialClaimV1, SshHostConfig } from "@/types";

const host: SshHostConfig = {
	id: "host-1",
	registrationGeneration: "registration-1",
	name: "Remote",
	host: "remote.example.test",
	port: 22,
	user: "dure",
	auth: "password",
	secretId: "secret-old",
};

function credential(
	idCharacter: string,
	registrationGeneration = host.registrationGeneration ?? "",
): SshCredentialClaimV1 {
	return {
		schemaVersion: 1,
		id: `ssh-${idCharacter.repeat(32)}`,
		hostId: host.id,
		registrationGeneration,
	};
}

async function installState(sshHosts: SshHostConfig[]): Promise<void> {
	await durableAppStorage.flush();
	localStorage.clear();
	const state = normalizePersistedState({
		spaces: [{ id: "space-1", name: "Main" }],
		sshHosts,
	});
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
		value: {
			version: PERSIST_VERSION,
			state: persistedSlice(state),
		},
		result: undefined,
	}));
	await rehydrateAppStoreFromDurableStorage();
}

async function installHost(value: SshHostConfig): Promise<void> {
	await installState([value]);
}

async function writeDurableHostsWithoutProjection(
	sshHosts: SshHostConfig[],
): Promise<void> {
	await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
		const state = normalizePersistedState(current?.state ?? {});
		return {
			value: {
				version: PERSIST_VERSION,
				state: persistedSlice({ ...state, sshHosts }),
			},
			result: undefined,
		};
	});
}

function durableHosts(): SshHostConfig[] {
	return (
		JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null") as {
			state: { sshHosts: SshHostConfig[] };
		}
	).state.sshHosts;
}

function durableHost(): SshHostConfig {
	return durableHosts()[0];
}

describe("SSH credential lifecycle", () => {
	it("converges concurrent GUI and CLI registration of the same manual key host", async () => {
		await installState([]);
		const draft = {
			name: "ec2-106",
			host: "example.test",
			user: "ec2-user",
			port: 22,
			auth: "key" as const,
			keyPath: "~/.ssh/key.pem",
		};
		const [first, second] = await Promise.all([
			createSshHostDurably(draft),
			createSshHostDurably(draft),
		]);
		expect(first.host.id).toBe(second.host.id);
		expect([first.created, second.created]).toEqual([true, false]);
		expect(durableHosts()).toHaveLength(1);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.recoverCurrentDurableStoreProjection.mockImplementation(async () => {
			await rehydrateAppStoreFromDurableStorage();
			return true;
		});
		mocks.sshCredentialClaimReconcile.mockResolvedValue({
			deleted: [],
			retained: [],
			failures: [],
		});
		mocks.sshCredentialClaimActivate.mockResolvedValue(undefined);
		mocks.sshCredentialClaimRetire.mockResolvedValue(undefined);
		mocks.sshCredentialClaimStage.mockResolvedValue(undefined);
		mocks.sshSecretCopy.mockResolvedValue(undefined);
		mocks.sshSecretSet.mockResolvedValue(undefined);
	});

	it("persists a non-secret auto-auth login once and preserves it through hydration", async () => {
		await installState([]);
		const draft = {
			name: "qa@192.0.2.1:22",
			host: "192.0.2.1",
			port: 22,
			user: "qa",
			auth: "auto" as const,
		};
		const [first, second] = await Promise.all([
			registerSshLoginHostDurably(draft),
			registerSshLoginHostDurably(draft),
		]);
		expect(first.created).toBe(true);
		expect(second).toEqual({ created: false, host: first.host });
		expect(durableHosts()).toHaveLength(1);
		expect(durableHost()).toMatchObject(draft);
		expect(durableHost().registrationGeneration).toBeTruthy();
		expect(durableHost()).not.toHaveProperty("password");
		expect(durableHost()).not.toHaveProperty("credential");
		expect(durableHost()).not.toHaveProperty("secretId");
		expect(mocks.sshSecretSet).not.toHaveBeenCalled();
		expect(mocks.sshCredentialClaimStage).not.toHaveBeenCalled();
		const saved = JSON.parse(
			localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
		);
		expect(normalizePersistedState(saved.state).sshHosts).toEqual([first.host]);
	});

	it("reuses a raced durable registration instead of trusting a stale WebView host list", async () => {
		await installState([]);
		const raced = { ...host, auth: "auto" as const, secretId: undefined };
		const read = durableAppStorage.read.bind(durableAppStorage);
		const spy = vi
			.spyOn(durableAppStorage, "read")
			.mockImplementationOnce(async (...args) => {
				const result = await read(...args);
				await writeDurableHostsWithoutProjection([raced]);
				return result;
			});
		try {
			const result = await registerSshLoginHostDurably({
				name: "Suggested",
				host: host.host,
				user: host.user,
				port: host.port,
				auth: "auto",
			});
			expect(result).toEqual({ created: false, host: raced });
			expect(durableHosts()).toHaveLength(1);
			expect(durableHost().name).toBe(host.name);
		} finally {
			spy.mockRestore();
		}
	});

	it("preserves ambiguous durable registrations and transient pending decisions", async () => {
		await installState([host, { ...host, id: "duplicate", name: "Another" }]);
		const before = durableHosts();
		const draft = {
			name: "Suggested",
			host: host.host,
			user: host.user,
			port: host.port,
			auth: "auto" as const,
		};
		await expect(registerSshLoginHostDurably(draft)).rejects.toThrow(
			"ambiguous",
		);
		expect(durableHosts()).toEqual(before);
		const result = useStore
			.getState()
			.requestSshRegistrationDecision("unanswered", draft, 30_000);
		const pending = useStore.getState().sshRegistrationDecisions[0];
		await durableAppStorage.flush();
		expect(
			JSON.parse(localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null").state,
		).not.toHaveProperty("sshRegistrationDecisions");
		await rehydrateAppStoreFromDurableStorage();
		expect(useStore.getState().sshRegistrationDecisions[0]).toBe(pending);
		pending.answer(false);
		await expect(result).resolves.toBe(false);
	});

	it("inserts a password Host only after its credential is live", async () => {
		await installState([]);
		let hostsAtSecretWrite: SshHostConfig[] | undefined;
		mocks.sshSecretSet.mockImplementationOnce(async () => {
			hostsAtSecretWrite = durableHosts();
		});

		const registration = await createSshHostDurably(
			{
				name: host.name,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
			"new-password",
		);

		expect(hostsAtSecretWrite).toEqual([]);
		expect(registration.created).toBe(true);
		expect(registration.host.credential?.id).toBe(
			mocks.sshSecretSet.mock.calls[0]?.[0],
		);
		expect(registration.host.secretId).toBe(registration.host.credential?.id);
		expect(mocks.sshCredentialClaimStage).toHaveBeenCalledWith([
			registration.host.credential,
		]);
		expect(mocks.sshCredentialClaimActivate).toHaveBeenCalledWith([
			registration.host.credential,
		]);
		expect(durableHosts()).toEqual([registration.host]);
	});

	it("never leaves an incomplete Host when its initial credential write fails", async () => {
		await installState([]);
		mocks.sshSecretSet.mockRejectedValueOnce(new Error("keychain unavailable"));

		await expect(
			createSshHostDurably(
				{
					name: host.name,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: "password",
					keyPath: undefined,
				},
				"new-password",
			),
		).rejects.toThrow("keychain unavailable");

		expect(mocks.sshCredentialClaimStage).toHaveBeenCalledOnce();
		expect(mocks.sshCredentialClaimActivate).not.toHaveBeenCalled();
		expect(durableHosts()).toEqual([]);
	});

	it("projects an existing durable config route before returning it", async () => {
		await installState([]);
		const alias = "gate";
		const existing: SshHostConfig = {
			...host,
			id: sshConfigHostId(alias),
			sshConfigAlias: alias,
			auth: "auto",
			secretId: undefined,
		};
		await writeDurableHostsWithoutProjection([existing]);

		await expect(
			createSshHostDurably({
				name: alias,
				sshConfigAlias: alias,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "auto",
				keyPath: undefined,
			}),
		).resolves.toEqual({ host: existing, created: false });

		expect(mocks.recoverCurrentDurableStoreProjection).toHaveBeenCalledOnce();
		expect(useStore.getState().sshHosts).toEqual([existing]);
	});

	it("keeps long config aliases inside the typed credential lifecycle", async () => {
		await installState([]);
		const alias = "a".repeat(60);

		const registration = await createSshHostDurably(
			{
				name: alias,
				sshConfigAlias: alias,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
			"new-password",
		);

		expect(registration.host.id.length).toBeGreaterThan(128);
		expect(registration.host.credential).toMatchObject({
			hostId: registration.host.id,
			registrationGeneration: registration.host.registrationGeneration,
		});
		expect(mocks.sshCredentialClaimStage).toHaveBeenCalledWith([
			registration.host.credential,
		]);
		expect(durableHost().credential).toEqual(registration.host.credential);
	});

	it("rotates operational generations so an ABA successor rejects a stale edit", async () => {
		const original = { ...host, auth: "auto" as const, secretId: undefined };
		await installHost(original);

		const changed = await updateSshHostCredentialsDurably({
			expected: original,
			next: {
				name: original.name,
				sshConfigAlias: original.sshConfigAlias,
				host: "changed.example.test",
				port: original.port,
				user: original.user,
				auth: "auto",
				keyPath: undefined,
			},
		});
		const successor = await updateSshHostCredentialsDurably({
			expected: changed,
			next: {
				name: original.name,
				sshConfigAlias: original.sshConfigAlias,
				host: original.host,
				port: original.port,
				user: original.user,
				auth: "auto",
				keyPath: undefined,
			},
		});

		expect(changed.registrationGeneration).not.toBe(
			original.registrationGeneration,
		);
		expect(successor.registrationGeneration).not.toBe(
			changed.registrationGeneration,
		);
		await expect(
			updateSshHostCredentialsDurably({
				expected: original,
				next: {
					name: "Stale edit",
					sshConfigAlias: original.sshConfigAlias,
					host: "stale.example.test",
					port: original.port,
					user: original.user,
					auth: "auto",
					keyPath: undefined,
				},
			}),
		).rejects.toThrow();
		expect(durableHost()).toMatchObject({
			host: original.host,
			registrationGeneration: successor.registrationGeneration,
		});
	});

	it("keeps credential identity for a presentation-only rename", async () => {
		const claim = credential("a");
		const owned = { ...host, credential: claim, secretId: claim.id };
		await installHost(owned);

		const saved = await updateSshHostCredentialsDurably({
			expected: owned,
			next: {
				name: "Renamed",
				sshConfigAlias: host.sshConfigAlias,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
		});

		expect(saved).toMatchObject({
			name: "Renamed",
			registrationGeneration: host.registrationGeneration,
			credential: claim,
			secretId: claim.id,
		});
		expect(mocks.sshCredentialClaimActivate).not.toHaveBeenCalled();
		expect(mocks.sshSecretCopy).not.toHaveBeenCalled();
		expect(mocks.sshSecretSet).not.toHaveBeenCalled();
	});

	it("copies a blank-password edit into a fresh owned credential", async () => {
		await installHost(host);

		const saved = await updateSshHostCredentialsDurably({
			expected: host,
			next: {
				name: host.name,
				sshConfigAlias: host.sshConfigAlias,
				host: "new-route.example.test",
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
		});

		expect(mocks.sshSecretCopy).toHaveBeenCalledWith(
			host.secretId,
			expect.any(String),
		);
		expect(saved.registrationGeneration).not.toBe(host.registrationGeneration);
		expect(saved.credential?.id).toBe(mocks.sshSecretCopy.mock.calls[0]?.[1]);
		expect(saved.secretId).toBe(saved.credential?.id);
	});

	it("stages successor and predecessor claims before an owned rotation", async () => {
		const predecessor = credential("b");
		const owned = {
			...host,
			credential: predecessor,
			secretId: predecessor.id,
		};
		await installHost(owned);

		const saved = await updateSshHostCredentialsDurably({
			expected: owned,
			next: {
				name: host.name,
				sshConfigAlias: host.sshConfigAlias,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
			password: "replacement-password",
		});

		const successor = saved.credential;
		expect(successor).toBeDefined();
		expect(mocks.sshCredentialClaimStage).toHaveBeenCalledWith([successor]);
		expect(mocks.sshCredentialClaimActivate).toHaveBeenCalledWith([successor]);
		expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledWith([predecessor]);
		expect(saved.secretId).toBe(successor?.id);
	});

	it("routes config alias adoption through a fresh generation", async () => {
		const predecessor = credential("i");
		const owned = {
			...host,
			credential: predecessor,
			secretId: predecessor.id,
		};
		await installHost(owned);

		const saved = await updateSshHostCredentialsDurably({
			expected: owned,
			next: {
				name: host.name,
				sshConfigAlias: "gate",
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
		});

		expect(saved.sshConfigAlias).toBe("gate");
		expect(saved.registrationGeneration).not.toBe(owned.registrationGeneration);
		expect(mocks.sshSecretCopy).toHaveBeenCalledWith(
			predecessor.id,
			saved.credential?.id,
		);
	});

	it("does not write a secret when native claim staging fails", async () => {
		await installHost(host);
		mocks.sshCredentialClaimStage.mockRejectedValueOnce(
			new Error("registry unavailable"),
		);

		await expect(
			updateSshHostCredentialsDurably({
				expected: host,
				next: {
					name: host.name,
					sshConfigAlias: host.sshConfigAlias,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: "password",
					keyPath: undefined,
				},
				password: "replacement-password",
			}),
		).rejects.toThrow("registry unavailable");
		expect(mocks.sshSecretSet).not.toHaveBeenCalled();
		expect(durableHost()).toMatchObject({
			registrationGeneration: host.registrationGeneration,
			secretId: host.secretId,
		});
	});

	it("serializes competing rotations so only one exact successor writes", async () => {
		const predecessor = credential("c");
		const owned = {
			...host,
			credential: predecessor,
			secretId: predecessor.id,
		};
		await installHost(owned);
		const next = {
			name: host.name,
			sshConfigAlias: host.sshConfigAlias,
			host: host.host,
			port: host.port,
			user: host.user,
			auth: "password" as const,
			keyPath: undefined,
		};

		const attempts = await Promise.allSettled([
			updateSshHostCredentialsDurably({
				expected: owned,
				next,
				password: "winner-one",
			}),
			updateSshHostCredentialsDurably({
				expected: owned,
				next,
				password: "winner-two",
			}),
		]);

		expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(mocks.sshSecretSet).toHaveBeenCalledOnce();
		expect(durableHost().credential?.id).toBe(
			mocks.sshSecretSet.mock.calls[0]?.[0],
		);
	});

	it("detaches an owned password credential after staging its cleanup intent", async () => {
		const predecessor = credential("d");
		const owned = {
			...host,
			credential: predecessor,
			secretId: predecessor.id,
		};
		await installHost(owned);

		await expect(
			updateSshHostCredentialsDurably({
				expected: owned,
				next: {
					name: host.name,
					sshConfigAlias: host.sshConfigAlias,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: "auto",
					keyPath: undefined,
				},
			}),
		).resolves.toMatchObject({ auth: "auto" });

		expect(mocks.sshCredentialClaimActivate).not.toHaveBeenCalled();
		expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledWith([predecessor]);
		expect(durableHost().credential).toBeUndefined();
		expect(durableHost().secretId).toBeUndefined();
	});

	it("sends typed claims and all live secret references to native reconciliation", async () => {
		const claim = credential("f");
		await installState([
			{ ...host, credential: claim, secretId: claim.id },
			{ ...host, id: "host-legacy", secretId: "legacy-shared" },
		]);
		mocks.sshCredentialClaimReconcile.mockResolvedValueOnce({
			deleted: ["ssh-retired"],
			retained: [claim.id],
			failures: [],
		});

		await expect(reconcileSshCredentialCleanup()).resolves.toEqual({
			deleted: ["ssh-retired"],
			retained: [claim.id],
		});
		expect(mocks.sshCredentialClaimReconcile).toHaveBeenCalledWith(
			[claim],
			[claim.id, "legacy-shared"],
		);
	});

	it("keeps Host removal behind an in-flight credential snapshot", async () => {
		const claim = credential("l");
		const owned = { ...host, credential: claim, secretId: claim.id };
		await installHost(owned);
		let releaseReconcile!: () => void;
		const reconcileReleased = new Promise<void>((resolve) => {
			releaseReconcile = resolve;
		});
		let markReconcileEntered!: () => void;
		const reconcileEntered = new Promise<void>((resolve) => {
			markReconcileEntered = resolve;
		});
		mocks.sshCredentialClaimReconcile.mockImplementationOnce(async () => {
			markReconcileEntered();
			await reconcileReleased;
			return { deleted: [], retained: [claim.id], failures: [] };
		});

		const reconcile = reconcileSshCredentialCleanup();
		await reconcileEntered;
		const removal = removeAgentProjectionDurably({
			agents: [],
			sshHosts: [
				{
					hostId: owned.id,
					applies: (candidate) =>
						candidate.registrationGeneration === owned.registrationGeneration,
				},
			],
		});
		await Promise.resolve();

		expect(durableHosts()).toEqual([owned]);
		releaseReconcile();
		await reconcile;
		await expect(removal).resolves.toBe(true);
		expect(durableHosts()).toEqual([]);
		expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledWith([claim]);
	});

	it("skips destructive reconciliation when the Host snapshot is unavailable", async () => {
		await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
			value: null,
			result: undefined,
		}));

		await expect(reconcileSshCredentialCleanup()).resolves.toEqual({
			deleted: [],
			retained: [],
		});
		expect(mocks.sshCredentialClaimReconcile).not.toHaveBeenCalled();
	});

	it("skips destructive reconciliation when persisted Hosts are malformed", async () => {
		await durableAppStorage.transact(DURABLE_APP_STORE_NAME, () => ({
			value: {
				version: PERSIST_VERSION,
				state: { sshHosts: "corrupt" } as unknown as ReturnType<
					typeof normalizePersistedState
				>,
			},
			result: undefined,
		}));

		await expect(reconcileSshCredentialCleanup()).resolves.toEqual({
			deleted: [],
			retained: [],
		});
		expect(mocks.sshCredentialClaimReconcile).not.toHaveBeenCalled();
	});

	it("detaches a password Host without claiming a legacy shared secret", async () => {
		await installHost(host);

		await updateSshHostCredentialsDurably({
			expected: host,
			next: {
				name: host.name,
				sshConfigAlias: host.sshConfigAlias,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "auto",
				keyPath: undefined,
			},
		});

		expect(mocks.sshCredentialClaimStage).not.toHaveBeenCalled();
		expect(mocks.sshCredentialClaimActivate).not.toHaveBeenCalled();
		expect(mocks.sshCredentialClaimRetire).not.toHaveBeenCalled();
		expect(durableHost()).toMatchObject({ id: host.id, auth: "auto" });
		expect(durableHost().secretId).toBeUndefined();
		expect(useStore.getState().sshHosts[0].secretId).toBeUndefined();
	});

	it("migrates an inline legacy password through an operation-owned secret", async () => {
		const legacy: SshHostConfig = {
			...host,
			registrationGeneration: undefined,
			secretId: undefined,
			password: "legacy-password",
		};
		await installHost(legacy);

		await migrateLegacySshCredentials();

		expect(mocks.sshSecretSet).toHaveBeenCalledOnce();
		const migrated = durableHost();
		expect(migrated.registrationGeneration).toHaveLength(16);
		expect(migrated.credential).toMatchObject({
			hostId: migrated.id,
			registrationGeneration: migrated.registrationGeneration,
		});
		expect(migrated.credential?.id).toBe(mocks.sshSecretSet.mock.calls[0]?.[0]);
		expect(migrated.secretId).toBe(migrated.credential?.id);
		expect(migrated.password).toBeUndefined();
	});

	it("migrates durable legacy credentials even when this WebView is stale", async () => {
		await installState([]);
		const legacy: SshHostConfig = {
			...host,
			registrationGeneration: undefined,
			secretId: undefined,
			password: "legacy-password",
		};
		await writeDurableHostsWithoutProjection([legacy]);

		await migrateLegacySshCredentials();

		expect(mocks.sshSecretSet).toHaveBeenCalledOnce();
		expect(durableHost().credential).toBeDefined();
		expect(durableHost().password).toBeUndefined();
	});

	it("keeps a committed secret when local projection recovery fails", async () => {
		await installHost(host);
		mocks.recoverCurrentDurableStoreProjection.mockRejectedValueOnce(
			new Error("projection failed"),
		);
		const projectionError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		const saved = await updateSshHostCredentialsDurably({
			expected: host,
			next: {
				name: host.name,
				sshConfigAlias: host.sshConfigAlias,
				host: host.host,
				port: host.port,
				user: host.user,
				auth: "password",
				keyPath: undefined,
			},
			password: "replacement-password",
		});

		expect(saved.credential?.id).toBe(mocks.sshSecretSet.mock.calls[0]?.[0]);
		expect(projectionError).toHaveBeenCalledWith(
			"[ssh credential projection]",
			expect.any(Error),
		);
	});

	it("preserves a same-generation rename that wins during credential I/O", async () => {
		await installHost(host);
		mocks.sshSecretSet.mockImplementationOnce(async () => {
			await durableAppStorage.transact(DURABLE_APP_STORE_NAME, (current) => {
				if (!current) throw new Error("durable Host state is unavailable");
				const state = normalizePersistedState(current.state);
				return {
					value: {
						version: PERSIST_VERSION,
						state: persistedSlice({
							...state,
							sshHosts: state.sshHosts.map((candidate) =>
								candidate.id === host.id
									? { ...candidate, name: "Concurrent rename" }
									: candidate,
							),
						}),
					},
					result: undefined,
				};
			});
		});

		await expect(
			updateSshHostCredentialsDurably({
				expected: host,
				next: {
					name: "Stale edit",
					sshConfigAlias: host.sshConfigAlias,
					host: host.host,
					port: host.port,
					user: host.user,
					auth: "password",
					keyPath: undefined,
				},
				password: "replacement-password",
			}),
		).rejects.toThrow();

		expect(durableHost()).toMatchObject({
			name: "Concurrent rename",
			secretId: host.secretId,
		});
		expect(mocks.sshCredentialClaimStage).toHaveBeenCalledOnce();
		expect(mocks.sshCredentialClaimActivate).toHaveBeenCalledOnce();
		expect(mocks.sshCredentialClaimRetire).toHaveBeenCalledOnce();
	});
});
