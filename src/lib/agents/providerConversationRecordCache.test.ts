import { afterEach, describe, expect, it, vi } from "vitest";

const loadRecord = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	loadProviderConversationRecord: loadRecord,
}));

import type { ProviderConversationDetailsTarget } from "@/lib/agents/providerConversationDiscovery";
import { readProviderConversationRecord } from "@/lib/agents/providerConversationRecordCache";

function target(conversationId: string): ProviderConversationDetailsTarget {
	return { provider: "claude", conversationId, executionLocation: "local" };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("readProviderConversationRecord", () => {
	it("shares one settled promise per conversation while the fingerprint holds", async () => {
		loadRecord.mockResolvedValue({ id: "c1" });
		const first = readProviderConversationRecord(target("cache-c1"), [], 100);
		const second = readProviderConversationRecord(target("cache-c1"), [], 100);
		expect(second).toBe(first);
		await first;
		expect(readProviderConversationRecord(target("cache-c1"), [], 100)).toBe(
			first,
		);
		expect(loadRecord).toHaveBeenCalledTimes(1);
	});

	it("reloads when the activity fingerprint moves", async () => {
		loadRecord.mockResolvedValue({ id: "c2" });
		await readProviderConversationRecord(target("cache-c2"), [], 100);
		await readProviderConversationRecord(target("cache-c2"), [], 200);
		expect(loadRecord).toHaveBeenCalledTimes(2);
		// The refreshed entry is cached under the new fingerprint.
		await readProviderConversationRecord(target("cache-c2"), [], 200);
		expect(loadRecord).toHaveBeenCalledTimes(2);
	});

	it("keys conversations separately", async () => {
		loadRecord.mockResolvedValue({});
		await readProviderConversationRecord(target("cache-c3"), [], 1);
		await readProviderConversationRecord(target("cache-c4"), [], 1);
		expect(loadRecord).toHaveBeenCalledTimes(2);
	});

	it("evicts a failed load so the next read retries", async () => {
		loadRecord.mockRejectedValueOnce(new Error("io"));
		await expect(
			readProviderConversationRecord(target("cache-c5"), [], 1),
		).rejects.toThrow("io");
		loadRecord.mockResolvedValueOnce({ id: "c5" });
		await expect(
			readProviderConversationRecord(target("cache-c5"), [], 1),
		).resolves.toEqual({ id: "c5" });
		expect(loadRecord).toHaveBeenCalledTimes(2);
	});
});
