import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	discoverProviderConversationsProgressively,
	listProviderConversations,
	loadProviderConversationDetails,
	loadProviderConversationRecord,
} from "@/lib/agents/providerConversationDiscovery";
import type { SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	listLocal: vi.fn(),
	listRemote: vi.fn(),
	loadLocalDetails: vi.fn(),
	loadRemoteDetails: vi.fn(),
	hostToOpts: vi.fn((host: SshHostConfig) => ({
		host: host.host,
		user: host.user,
	})),
}));

vi.mock("@/lib/ipc", () => ({
	hostToOpts: mocks.hostToOpts,
	getProviderConversationDetails: mocks.loadLocalDetails,
	getRemoteProviderConversationDetails: mocks.loadRemoteDetails,
	listProviderConversationRecords: mocks.listLocal,
	listRemoteProviderConversationRecords: mocks.listRemote,
}));

const host = (
	id: string,
	auth: SshHostConfig["auth"],
	extra: Partial<SshHostConfig> = {},
): SshHostConfig => ({
	id,
	name: id,
	host: `${id}.test`,
	port: 22,
	user: "agent",
	auth,
	...extra,
});

const record = (id: string, mtime: number, hostId?: string) => ({
	provider: "codex" as const,
	id,
	cwd: "/repo",
	title: id,
	mtime,
	resumeCapability: "exact" as const,
	executionLocation: hostId ? ("ssh" as const) : ("local" as const),
	...(hostId ? { hostId } : {}),
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("provider conversation discovery", () => {
	it("publishes local records without waiting for a slow remote host", async () => {
		let resolveLocal: (records: ReturnType<typeof record>[]) => void = () =>
			undefined;
		let rejectRemote: (error: Error) => void = () => undefined;
		mocks.listLocal.mockReturnValue(
			new Promise((resolve) => {
				resolveLocal = resolve;
			}),
		);
		mocks.listRemote.mockReturnValue(
			new Promise((_resolve, reject) => {
				rejectRemote = reject;
			}),
		);
		const snapshots: Parameters<
			Parameters<typeof discoverProviderConversationsProgressively>[1]
		>[0][] = [];
		const discovery = discoverProviderConversationsProgressively(
			[host("remote", "auto")],
			(snapshot) => snapshots.push(snapshot),
		);

		expect(
			snapshots[snapshots.length - 1]?.sources.map((source) => source.status),
		).toEqual(["pending", "pending"]);
		resolveLocal([record("local", 10)]);
		await vi.waitFor(() =>
			expect(
				snapshots[snapshots.length - 1]?.records.map(({ id }) => id),
			).toEqual(["local"]),
		);
		expect(snapshots[snapshots.length - 1]).toMatchObject({
			complete: false,
			sources: [
				{ key: "local", status: "succeeded", count: 1 },
				{ key: "ssh:remote", status: "pending", count: 0 },
			],
		});

		rejectRemote(new Error("offline secret detail"));
		await expect(discovery).resolves.toMatchObject({
			complete: true,
			records: [{ id: "local" }],
			sources: [
				{ key: "local", status: "succeeded" },
				{ key: "ssh:remote", status: "failed" },
			],
		});
	});

	it("does not publish settled results after the caller aborts", async () => {
		let resolveLocal: (records: ReturnType<typeof record>[]) => void = () =>
			undefined;
		mocks.listLocal.mockReturnValue(
			new Promise((resolve) => {
				resolveLocal = resolve;
			}),
		);
		const controller = new AbortController();
		const snapshots: unknown[] = [];
		const discovery = discoverProviderConversationsProgressively(
			[],
			(snapshot) => snapshots.push(snapshot),
			controller.signal,
		);
		expect(snapshots).toHaveLength(1);

		controller.abort();
		resolveLocal([record("late", 10)]);
		await discovery;

		expect(snapshots).toHaveLength(1);
	});

	it("merges local and eligible saved hosts while isolating remote failures", async () => {
		mocks.listLocal.mockResolvedValue([record("local", 10)]);
		mocks.listRemote.mockImplementation((hostId: string) => {
			if (hostId === "auto") {
				return Promise.resolve([record("remote", 30, "auto")]);
			}
			if (hostId === "key") return Promise.reject(new Error("offline"));
			if (hostId === "password") {
				return Promise.resolve([record("local", 20, "password")]);
			}
			throw new Error(`unexpected host ${hostId}`);
		});

		const result = await listProviderConversations([
			host("auto", "auto"),
			host("key", "key", { keyPath: "/tmp/key" }),
			host("password", "password", { secretId: "saved" }),
			host("interactive-password", "password"),
			host("missing-key", "key"),
		]);

		expect(result.map(({ id, hostId }) => [id, hostId])).toEqual([
			["remote", "auto"],
			["local", "password"],
			["local", undefined],
		]);
		expect(mocks.listRemote.mock.calls.map(([hostId]) => hostId)).toEqual([
			"auto",
			"key",
			"password",
		]);
	});

	it("bounds automatic remote discovery to eight eligible hosts", async () => {
		mocks.listLocal.mockResolvedValue([]);
		mocks.listRemote.mockResolvedValue([]);

		const final = await discoverProviderConversationsProgressively(
			Array.from({ length: 12 }, (_, index) => host(`remote-${index}`, "auto")),
			() => undefined,
		);

		expect(mocks.listRemote).toHaveBeenCalledTimes(8);
		expect(final.sources.map((source) => source.key)).toEqual([
			"local",
			...Array.from({ length: 8 }, (_, index) => `ssh:remote-${index}`),
		]);
	});

	it("ignores empty and duplicate remote source identities", async () => {
		mocks.listLocal.mockResolvedValue([]);
		mocks.listRemote.mockResolvedValue([]);

		const final = await discoverProviderConversationsProgressively(
			[
				host("remote", "auto"),
				host("remote", "auto", { name: "duplicate" }),
				host("   ", "auto"),
				host("other", "auto"),
			],
			() => undefined,
		);

		expect(mocks.listRemote.mock.calls.map(([hostId]) => hostId)).toEqual([
			"remote",
			"other",
		]);
		expect(final.sources.map((source) => source.key)).toEqual([
			"local",
			"ssh:remote",
			"ssh:other",
		]);
	});

	it("deduplicates only within the same execution location", async () => {
		mocks.listLocal.mockResolvedValue([record("same", 10), record("same", 5)]);
		mocks.listRemote.mockImplementation((hostId: string) =>
			Promise.resolve([record("same", 20, hostId), record("same", 15, hostId)]),
		);

		const result = await listProviderConversations([host("remote", "auto")]);

		expect(result).toHaveLength(2);
		expect(result.map((candidate) => candidate.executionLocation)).toEqual([
			"ssh",
			"local",
		]);
	});

	it("loads one conversation from only its exact execution source", async () => {
		const remote = host("remote", "auto");
		mocks.listLocal.mockResolvedValue([
			record("local-conversation", 10),
			record("other-local", 9),
		]);
		mocks.listRemote.mockResolvedValue([
			record("remote-conversation", 20, "remote"),
		]);

		await expect(
			loadProviderConversationRecord(
				{
					provider: "codex",
					conversationId: "local-conversation",
					executionLocation: "local",
				},
				[remote],
			),
		).resolves.toMatchObject({ id: "local-conversation" });
		await expect(
			loadProviderConversationRecord(
				{
					provider: "codex",
					conversationId: "remote-conversation",
					executionLocation: "ssh",
					hostId: "remote",
				},
				[remote],
			),
		).resolves.toMatchObject({
			id: "remote-conversation",
			hostId: "remote",
		});

		expect(mocks.listLocal).toHaveBeenCalledOnce();
		expect(mocks.listRemote).toHaveBeenCalledWith("remote", {
			host: "remote.test",
			user: "agent",
		});
	});

	it("loads details from the exact local or saved SSH execution host", async () => {
		const remote = host("remote", "auto");
		mocks.loadLocalDetails.mockResolvedValue({ subagents: [], totalCount: 0 });
		mocks.loadRemoteDetails.mockResolvedValue({
			subagents: [],
			totalCount: 0,
		});

		await loadProviderConversationDetails(
			{
				provider: "claude",
				conversationId: "local-conversation",
				executionLocation: "local",
			},
			[remote],
		);
		await loadProviderConversationDetails(
			{
				provider: "claude",
				conversationId: "remote-conversation",
				executionLocation: "ssh",
				hostId: "remote",
			},
			[remote],
		);

		expect(mocks.loadLocalDetails).toHaveBeenCalledWith(
			"claude",
			"local-conversation",
		);
		expect(mocks.loadRemoteDetails).toHaveBeenCalledWith(
			"remote",
			{ host: "remote.test", user: "agent" },
			"claude",
			"remote-conversation",
		);
	});

	it("refuses remote details when the exact saved host is unavailable", async () => {
		await expect(
			loadProviderConversationDetails(
				{
					provider: "claude",
					conversationId: "remote-conversation",
					executionLocation: "ssh",
					hostId: "missing-host",
				},
				[host("other-host", "auto")],
			),
		).rejects.toThrow("provider_conversation_host_unavailable");
		expect(mocks.loadRemoteDetails).not.toHaveBeenCalled();
	});
});
