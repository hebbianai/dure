import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DURABLE_APP_STORE_NAME } from "./durableAppStoreName";
import { DurableWriteCoordinator } from "./durableWriteCoordinator";
import {
	createWorktreePresentationEnvelope,
	readWorktreePresentationEnvelope,
} from "./worktreePresentationEnvelope";
import {
	exportWorktreePresentation,
	importFirstWorktreePresentation,
} from "./worktreePresentationTransfer";

const identity = {
	sourceChannel: "dev-task-0123456789",
	targetChannel: "release-task-0123456789",
};
const original = JSON.stringify({
	version: 8,
	state: {
		spaces: [{ id: "space-a", name: "Work", agentIds: ["agent-a"] }],
		layouts: {
			"space-a": { panels: { "agent:agent-a": { id: "agent:agent-a" } } },
		},
		agents: [
			{
				id: "agent-a",
				hmuxSessionId: "session-a",
				providerConversationId: "thread-a",
			},
		],
	},
});

function storage(initial: string | null = null) {
	const values = new Map(
		initial === null ? [] : [[DURABLE_APP_STORE_NAME, initial]],
	);
	return {
		values,
		getItem: vi.fn((key: string) => values.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => {
			values.set(key, value);
		}),
	};
}

function coordinator() {
	return new DurableWriteCoordinator({
		request: (_name, operation) => Promise.resolve(operation()),
	});
}

beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
});

describe("worktree presentation transfer", () => {
	it("preserves the complete source bytes, layouts and runtime bindings", async () => {
		const source = storage(original);
		const target = storage();
		const raw = await exportWorktreePresentation(source, coordinator());
		const envelope = await createWorktreePresentationEnvelope(identity, raw);
		expect(
			await importFirstWorktreePresentation(
				identity,
				async () => envelope,
				8,
				target,
				coordinator(),
			),
		).toBe("imported");
		expect(target.values.get(DURABLE_APP_STORE_NAME)).toBe(original);
		expect(source.values.get(DURABLE_APP_STORE_NAME)).toBe(original);
		expect(source.setItem).not.toHaveBeenCalled();
	});

	it("does not repair or remove absent or corrupt source data", async () => {
		for (const raw of [null, "{corrupt", '{"state":{},"version":"8"}']) {
			const source = storage(raw);
			await expect(
				exportWorktreePresentation(source, coordinator()),
			).rejects.toThrow();
			expect(source.getItem(DURABLE_APP_STORE_NAME)).toBe(raw);
			expect(source.setItem).not.toHaveBeenCalled();
		}
	});

	it("retains existing destination data without requiring the old export", async () => {
		const target = storage("existing destination, even if corrupt");
		const read = vi.fn(async () => {
			throw new Error("source offline");
		});
		expect(
			await importFirstWorktreePresentation(
				identity,
				read,
				8,
				target,
				coordinator(),
			),
		).toBe("existing");
		expect(read).not.toHaveBeenCalled();
		expect(target.setItem).not.toHaveBeenCalled();
	});

	it("does not resurrect the original agents after an intentional destination reset", async () => {
		const target = storage();
		expect(
			await importFirstWorktreePresentation(
				identity,
				async () => null,
				8,
				target,
				coordinator(),
			),
		).toBe("consumed");
		expect(target.setItem).not.toHaveBeenCalled();
		expect(target.values.size).toBe(0);
	});

	it("rejects a changed payload, a different worktree and the stable namespace", async () => {
		const envelope = await createWorktreePresentationEnvelope(
			identity,
			original,
		);
		for (const value of [
			{
				...envelope,
				serializedValue: original.replace("thread-a", "thread-b"),
			},
			{ ...envelope, sourceChannel: "dev-other-9876543210" },
			{ ...envelope, targetChannel: "stable" },
			{ ...envelope, schemaVersion: 2 },
		]) {
			const target = storage();
			await expect(
				importFirstWorktreePresentation(
					identity,
					async () => value,
					8,
					target,
					coordinator(),
				),
			).rejects.toThrow();
			expect(target.setItem).not.toHaveBeenCalled();
		}
		await expect(
			readWorktreePresentationEnvelope(envelope, {
				...identity,
				targetChannel: "stable",
			}),
		).rejects.toThrow("channel_invalid");
	});

	it("refuses a future store schema before writing", async () => {
		const envelope = await createWorktreePresentationEnvelope(
			identity,
			original.replace('"version":8', '"version":9'),
		);
		const target = storage();
		await expect(
			importFirstWorktreePresentation(
				identity,
				async () => envelope,
				8,
				target,
				coordinator(),
			),
		).rejects.toThrow("version_unsupported");
		expect(target.setItem).not.toHaveBeenCalled();
	});

	it("serializes simultaneous first launches so only one import writes", async () => {
		const envelope = await createWorktreePresentationEnvelope(
			identity,
			original,
		);
		const target = storage();
		const writes = coordinator();
		const read = vi.fn(async () => envelope);
		expect(
			await Promise.all([
				importFirstWorktreePresentation(identity, read, 8, target, writes),
				importFirstWorktreePresentation(identity, read, 8, target, writes),
			]),
		).toEqual(["imported", "existing"]);
		expect(target.setItem).toHaveBeenCalledTimes(1);
	});

	it("waits for an earlier committed write rather than exporting its predecessor", async () => {
		const source = storage(original);
		const writes = coordinator();
		const newer = original.replace("thread-a", "thread-new");
		const queued = writes.run(DURABLE_APP_STORE_NAME, () =>
			source.setItem(DURABLE_APP_STORE_NAME, newer),
		);
		const exported = exportWorktreePresentation(source, writes);
		await queued;
		expect(await exported).toBe(newer);
		expect(source.setItem).toHaveBeenCalledTimes(1);
	});

	it("keeps the destination empty on storage failure and permits an explicit retry", async () => {
		const envelope = await createWorktreePresentationEnvelope(
			identity,
			original,
		);
		const target = storage();
		target.setItem.mockImplementationOnce(() => {
			throw new Error("quota exceeded");
		});
		const writes = coordinator();
		await expect(
			importFirstWorktreePresentation(
				identity,
				async () => envelope,
				8,
				target,
				writes,
			),
		).rejects.toThrow("quota exceeded");
		expect(target.values.size).toBe(0);
		expect(
			await importFirstWorktreePresentation(
				identity,
				async () => envelope,
				8,
				target,
				writes,
			),
		).toBe("imported");
	});
});
