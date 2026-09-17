import { describe, expect, it, vi } from "vitest";
import {
	createRecentSessionHistoryResource,
	recentSessionHistoryScopeKey,
} from "@/lib/sessions/recentSessionHistoryResource";
import type { SshHostConfig } from "@/types";

const conversation = {
	provider: "claude" as const,
	id: "conversation-1",
	title: "Warm history",
	mtime: 1,
	cwd: "/repo",
	resumeCapability: "exact" as const,
	executionLocation: "local" as const,
};

describe("recent session history resource", () => {
	it("shares one in-flight load across simultaneous sidebar consumers", async () => {
		let resolveLoad!: (entries: readonly (typeof conversation)[]) => void;
		const pending = new Promise<readonly (typeof conversation)[]>((resolve) => {
			resolveLoad = resolve;
		});
		const load = vi.fn().mockReturnValue(pending);
		const resource = createRecentSessionHistoryResource(load);
		const hosts: SshHostConfig[] = [];

		const first = resource.ensureLoaded(hosts);
		const second = resource.ensureLoaded(hosts);
		expect(load).toHaveBeenCalledTimes(1);
		resolveLoad([conversation]);
		await Promise.all([first, second]);

		expect(
			resource.getSnapshot(recentSessionHistoryScopeKey(hosts)).loadState,
		).toBe("ready");
	});

	it("deduplicates fresh remount loads and revalidates only after staleness", async () => {
		let now = 1_000;
		const load = vi.fn().mockResolvedValue([conversation]);
		const resource = createRecentSessionHistoryResource(load, {
			now: () => now,
			staleAfterMs: 30_000,
		});
		const hosts: SshHostConfig[] = [];
		const scopeKey = recentSessionHistoryScopeKey(hosts);

		await resource.ensureLoaded(hosts);
		await resource.ensureLoaded(hosts);

		expect(load).toHaveBeenCalledTimes(1);
		expect(resource.getSnapshot(scopeKey)).toMatchObject({
			entries: [conversation],
			loadState: "ready",
		});

		now += 30_001;
		await resource.ensureLoaded(hosts);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("keeps the last successful entries visible during refresh and failure", async () => {
		let rejectRefresh!: (reason?: unknown) => void;
		const refresh = new Promise<readonly (typeof conversation)[]>(
			(_resolve, reject) => {
				rejectRefresh = reject;
			},
		);
		const load = vi
			.fn()
			.mockResolvedValueOnce([conversation])
			.mockReturnValueOnce(refresh);
		const resource = createRecentSessionHistoryResource(load);
		const hosts: SshHostConfig[] = [];
		const scopeKey = recentSessionHistoryScopeKey(hosts);
		await resource.refresh(hosts);

		const request = resource.refresh(hosts);
		expect(resource.getSnapshot(scopeKey)).toMatchObject({
			entries: [conversation],
			loadState: "loading",
		});
		rejectRefresh(new Error("temporary scan failure"));
		await request;

		expect(resource.getSnapshot(scopeKey)).toMatchObject({
			entries: [conversation],
			loadState: "error",
		});
	});

	it("does not let an older refresh overwrite the newest provider snapshot", async () => {
		let resolveOlder!: (entries: readonly (typeof conversation)[]) => void;
		let resolveNewer!: (entries: readonly (typeof conversation)[]) => void;
		const older = new Promise<readonly (typeof conversation)[]>((resolve) => {
			resolveOlder = resolve;
		});
		const newer = new Promise<readonly (typeof conversation)[]>((resolve) => {
			resolveNewer = resolve;
		});
		const newestConversation = {
			...conversation,
			id: "conversation-newest",
			title: "Newest history",
		};
		const load = vi
			.fn()
			.mockReturnValueOnce(older)
			.mockReturnValueOnce(newer);
		const resource = createRecentSessionHistoryResource(load);
		const hosts: SshHostConfig[] = [];
		const scopeKey = recentSessionHistoryScopeKey(hosts);

		const olderRequest = resource.refresh(hosts);
		const newerRequest = resource.refresh(hosts);
		resolveNewer([newestConversation]);
		await newerRequest;
		resolveOlder([conversation]);
		await olderRequest;

		expect(resource.getSnapshot(scopeKey)).toMatchObject({
			entries: [newestConversation],
			loadState: "ready",
		});
	});

	it("does not retain plaintext SSH passwords in cache scope identities", () => {
		const host: SshHostConfig = {
			id: "build",
			name: "Build Mac",
			host: "build.test",
			port: 22,
			user: "agent",
			auth: "password",
			password: "do-not-cache-this",
		};

		const scopeKey = recentSessionHistoryScopeKey([host]);
		expect(scopeKey).not.toContain(host.password ?? "");
		expect(scopeKey).toContain("build.test");
	});
});
