import { beforeEach, describe, expect, it } from "vitest";
import {
	beginQuickDispatchIntent,
	completeQuickDispatchIntent,
	failQuickDispatchIntent,
	newQuickDispatchIntentId,
	pinQuickDispatchIntentResolution,
	readQuickDispatchIntents,
} from "@/lib/agents/quickDispatch/quickDispatchIntent";

const input = {
	promptText: "fix it",
	attachmentPaths: ["/a/1.png"],
	projectId: "p1",
	providerId: "claude" as const,
	accountId: null,
	model: null,
	effort: null,
	typedName: null,
};

describe("quick-dispatch intent journal", () => {
	beforeEach(() => localStorage.clear());
	it("retains the exact remote target across journal reload and refuses malformed targets", () => {
		const remoteTarget = { hostId: "host", path: "/repo", host: "build.test", port: 22, user: "dev", registrationGeneration: "generation", sshConfigAlias: null };
		const intent = beginQuickDispatchIntent({ ...input, remoteTarget });
		expect(readQuickDispatchIntents()[0].remoteTarget).toEqual(remoteTarget);
		for (const patch of [{ port: 0 }, { hostId: "" }, { path: "relative" }, { extra: true }]) {
			localStorage.setItem("dure:quick-dispatch-intents:v1", JSON.stringify({ schemaVersion: 1, intents: [{ ...intent, remoteTarget: { ...remoteTarget, ...patch } }] }));
			expect(readQuickDispatchIntents()).toEqual([]);
		}
	});
	it.each([false, true])("retains the worktree choice across reload and resolution (%s)", (useWorktree) => {
		const intent = beginQuickDispatchIntent({ ...input, useWorktree });
		const resolution = { resolvedName: "fix-it", resolvedBaseSha: useWorktree ? "a".repeat(40) : null, resolvedSetupCommand: null };
		pinQuickDispatchIntentResolution(intent.intentId, resolution);
		expect(readQuickDispatchIntents()[0]).toMatchObject({ useWorktree, ...resolution });
		expect(pinQuickDispatchIntentResolution(intent.intentId, { ...resolution, resolvedName: "other" })).toEqual(resolution);
	});

	it.each([
		{ useWorktree: false, resolvedBaseSha: "a".repeat(40) },
		{ useWorktree: true, resolvedBaseSha: null },
		{ useWorktree: false, resolvedSetupCommand: "pnpm install" },
	])("rejects resolution inconsistent with the selected worktree mode: %j", (invalid) => {
		const intent = beginQuickDispatchIntent(input);
		localStorage.setItem("dure:quick-dispatch-intents:v1", JSON.stringify({ schemaVersion: 1, intents: [{ ...intent, ...invalid }] }));
		expect(readQuickDispatchIntents()).toEqual([]);
	});

	it("preserves the exact auto-edit permission in the journal", () => {
		beginQuickDispatchIntent({ ...input, permissionOverride: "auto_edit" } as Parameters<typeof beginQuickDispatchIntent>[0]);
		expect(readQuickDispatchIntents()[0]).toMatchObject({ permissionOverride: "auto_edit" });
	});

	it("preserves per-dispatch advanced choices across journal reload", () => {
		const advanced = { ...input, permissionOverride: "require_approvals" as const, runSetup: false };
		beginQuickDispatchIntent(advanced);
		expect(readQuickDispatchIntents()[0]).toMatchObject({ permissionOverride: "require_approvals", runSetup: false });
	});

	it.each([{ permissionOverride: "unknown" }, { runSetup: "false" }, { useWorktree: "false" }])("rejects malformed advanced choices on the journal boundary: %j", (invalid) => {
		const intent = beginQuickDispatchIntent(input);
		localStorage.setItem("dure:quick-dispatch-intents:v1", JSON.stringify({ schemaVersion: 1, intents: [{ ...intent, ...invalid }] }));
		expect(readQuickDispatchIntents()).toEqual([]);
	});

	it("does not invent overrides when reloading a legacy intent", () => {
		beginQuickDispatchIntent(input);
		const [stored] = readQuickDispatchIntents();
		expect(stored.permissionOverride).toBeUndefined();
		expect(stored.runSetup).toBeUndefined();
	});

	it("persists on begin and disappears on complete", () => {
		const intent = beginQuickDispatchIntent(input);
		expect(readQuickDispatchIntents()).toHaveLength(1);
		completeQuickDispatchIntent(intent.intentId);
		expect(readQuickDispatchIntents()).toHaveLength(0);
	});

	it("marks failures with a code and keeps the record", () => {
		const intent = beginQuickDispatchIntent(input);
		failQuickDispatchIntent(intent.intentId, {
			code: "x",
			message: "boom",
			atMs: 1,
		});
		const [stored] = readQuickDispatchIntents();
		expect(stored.state).toBe("failed");
		expect(stored.failure?.code).toBe("x");
	});

	it("drops malformed stored payloads instead of throwing", () => {
		localStorage.setItem("dure:quick-dispatch-intents:v1", "{not json");
		expect(readQuickDispatchIntents()).toEqual([]);
	});

	it("generates ids that satisfy the Rust intent-id rule", () => {
		expect(newQuickDispatchIntentId()).toMatch(/^qd_[a-f0-9]{32}$/);
	});

	it("bounds the stored intent count", () => {
		for (let i = 0; i < 20; i += 1) beginQuickDispatchIntent(input);
		expect(readQuickDispatchIntents().length).toBeLessThanOrEqual(16);
	});

	it("evicts the oldest intent first when the bound is exceeded", () => {
		const ids: string[] = [];
		for (let i = 0; i < 17; i += 1) {
			ids.push(beginQuickDispatchIntent(input).intentId);
		}
		const stored = readQuickDispatchIntents().map((intent) => intent.intentId);
		expect(stored).toHaveLength(16);
		// oldest (first-created) id was evicted; the newest 16 remain, in order.
		expect(stored).not.toContain(ids[0]);
		expect(stored).toEqual(ids.slice(1));
	});

	it("completeQuickDispatchIntent also removes a failed record", () => {
		const intent = beginQuickDispatchIntent(input);
		failQuickDispatchIntent(intent.intentId, {
			code: "x",
			message: "boom",
			atMs: 1,
		});
		completeQuickDispatchIntent(intent.intentId);
		expect(readQuickDispatchIntents()).toHaveLength(0);
	});

	it("drops the whole set when the stored envelope shape is wrong", () => {
		beginQuickDispatchIntent(input);
		localStorage.setItem(
			"dure:quick-dispatch-intents:v1",
			JSON.stringify({ schemaVersion: 1, intents: [{ nope: true }] }),
		);
		expect(readQuickDispatchIntents()).toEqual([]);
	});

	it("round-trips every stored field including attachments and overrides", () => {
		const intent = beginQuickDispatchIntent({
			promptText: "do the thing",
			attachmentPaths: ["/a/1.png", "/a/2.png"],
			projectId: "p2",
			providerId: "codex" as const,
			model: "gpt-5",
			effort: "xhigh",
			accountId: "acc-codex-work",
			typedName: "my-task",
		});
		const [stored] = readQuickDispatchIntents();
		expect(stored).toEqual({
			schemaVersion: 1,
			intentId: intent.intentId,
			createdAtMs: intent.createdAtMs,
			promptText: "do the thing",
			attachmentPaths: ["/a/1.png", "/a/2.png"],
			projectId: "p2",
			providerId: "codex",
			model: "gpt-5",
			effort: "xhigh",
			accountId: "acc-codex-work",
			typedName: "my-task",
			state: "pending",
		});
	});

	// F4: the on-disk attachment directory is named after the id the overlay
	// pre-generates before the journal write, so the journal must be able to
	// reuse that exact id instead of minting its own.
	it("uses a supplied intentId instead of minting its own", () => {
		const suppliedId = newQuickDispatchIntentId();
		const intent = beginQuickDispatchIntent(input, suppliedId);
		expect(intent.intentId).toBe(suppliedId);
		const [stored] = readQuickDispatchIntents();
		expect(stored.intentId).toBe(suppliedId);
	});

	it("rejects a supplied intentId that doesn't match the qd_<hex32> shape", () => {
		expect(() => beginQuickDispatchIntent(input, "not-a-valid-id")).toThrow();
		expect(readQuickDispatchIntents()).toHaveLength(0);
	});

	// F3: attachment-only dispatch (empty task text, at least one attachment)
	// must be accepted — the assembled prompt (buildQuickDispatchPrompt) is
	// non-empty from the attachment reference lines alone.
	it("accepts empty promptText when at least one attachment is present", () => {
		const intent = beginQuickDispatchIntent({
			...input,
			promptText: "",
			attachmentPaths: ["/a/1.png"],
		});
		expect(intent.promptText).toBe("");
		expect(readQuickDispatchIntents()).toHaveLength(1);
	});

	it("still rejects empty promptText with no attachments", () => {
		expect(() =>
			beginQuickDispatchIntent({
				...input,
				promptText: "",
				attachmentPaths: [],
			}),
		).toThrow();
		expect(readQuickDispatchIntents()).toHaveLength(0);
	});

	it("rejects a model longer than the shared transport bound", () => {
		expect(() =>
			beginQuickDispatchIntent({ ...input, model: "a".repeat(257) }),
		).toThrow();
	});

	it("persists a namespaced model at the shared transport boundary", () => {
		const model = `provider/${"a".repeat(247)}`;
		const intent = beginQuickDispatchIntent({
			...input,
			model,
		});
		expect(intent.model).toBe(model);
		expect(readQuickDispatchIntents()[0].model).toBe(model);
	});

	it("rejects an effort that breaks the transport selection rule", () => {
		expect(() =>
			beginQuickDispatchIntent({ ...input, effort: "-bad effort-" }),
		).toThrow();
		expect(() =>
			beginQuickDispatchIntent({ ...input, effort: "a".repeat(65) }),
		).toThrow();
	});

	// Effort is a later addition to the v1 record: journal entries written
	// before it existed carry no `effort` key and must stay readable.
	it("keeps reading records journaled before the effort field existed", () => {
		const intent = beginQuickDispatchIntent(input);
		const raw = localStorage.getItem("dure:quick-dispatch-intents:v1");
		expect(raw).not.toBeNull();
		expect(raw).not.toContain('"effort"');
		const [stored] = readQuickDispatchIntents();
		expect(stored.intentId).toBe(intent.intentId);
		expect(stored.effort).toBeUndefined();
	});

	it("keeps reading records journaled before credential selection existed", () => {
		const intent = beginQuickDispatchIntent(input);
		const key = "dure:quick-dispatch-intents:v1";
		const journal = JSON.parse(localStorage.getItem(key) ?? "") as {
			intents: Array<Record<string, unknown>>;
		};
		delete journal.intents[0].accountId;
		localStorage.setItem(key, JSON.stringify(journal));

		const [stored] = readQuickDispatchIntents();
		expect(stored.intentId).toBe(intent.intentId);
		expect(stored.accountId).toBeUndefined();
	});

	it("rejects an invalid credential identifier", () => {
		expect(() =>
			beginQuickDispatchIntent({ ...input, accountId: "bad\ncredential" }),
		).toThrow();
		expect(() =>
			beginQuickDispatchIntent({ ...input, accountId: "" }),
		).toThrow();
	});

	it("preserves a legacy partial resolution while filling its missing inputs", () => {
		const intent = beginQuickDispatchIntent(input);
		const key = "dure:quick-dispatch-intents:v1";
		const journal = JSON.parse(localStorage.getItem(key) ?? "") as {
			intents: Array<Record<string, unknown>>;
		};
		journal.intents[0].resolvedName = "legacy-name";
		localStorage.setItem(key, JSON.stringify(journal));

		const [legacy] = readQuickDispatchIntents();
		expect(legacy.resolvedName).toBe("legacy-name");
		const pinned = pinQuickDispatchIntentResolution(intent.intentId, {
			resolvedName: "new-name",
			resolvedBaseSha: "a".repeat(40),
			resolvedSetupCommand: null,
		});

		expect(pinned).toEqual({
			resolvedName: "legacy-name",
			resolvedBaseSha: "a".repeat(40),
			resolvedSetupCommand: null,
		});
	});

	// F2: the derived request is pinned onto an existing intent so
	// a resume after a crash reuses them instead of re-deriving possibly
	// different values.
	describe("pinQuickDispatchIntentResolution", () => {
		it("pins name, base SHA, and setup decision together", () => {
			const intent = beginQuickDispatchIntent(input);
			const sha = "a".repeat(40);
			const pinned = pinQuickDispatchIntentResolution(intent.intentId, {
				resolvedName: "fix-sidebar-flicker",
				resolvedBaseSha: sha,
				resolvedSetupCommand: null,
			});
			const [stored] = readQuickDispatchIntents();
			expect(pinned).toEqual({
				resolvedName: "fix-sidebar-flicker",
				resolvedBaseSha: sha,
				resolvedSetupCommand: null,
			});
			expect(stored.resolvedName).toBe("fix-sidebar-flicker");
			expect(stored.resolvedBaseSha).toBe(sha);
			expect(stored.resolvedSetupCommand).toBeNull();
		});

		it("returns the first resolution instead of overwriting its authority", () => {
			const intent = beginQuickDispatchIntent(input);
			const first = pinQuickDispatchIntentResolution(intent.intentId, {
				resolvedName: "fix-sidebar-flicker",
				resolvedBaseSha: "b".repeat(40),
				resolvedSetupCommand: null,
			});
			const second = pinQuickDispatchIntentResolution(intent.intentId, {
				resolvedName: "fix-terminal-flicker",
				resolvedBaseSha: "c".repeat(40),
				resolvedSetupCommand: "pnpm install",
			});
			const [stored] = readQuickDispatchIntents();
			expect(second).toEqual(first);
			expect(stored.resolvedName).toBe("fix-sidebar-flicker");
			expect(stored.resolvedBaseSha).toBe("b".repeat(40));
			expect(stored.resolvedSetupCommand).toBeNull();
		});

		it("rejects a resolvedName that fails the canonical agent-name rule", () => {
			const intent = beginQuickDispatchIntent(input);
			expect(() =>
				pinQuickDispatchIntentResolution(intent.intentId, {
					resolvedName: "Not Canonical!",
					resolvedBaseSha: "b".repeat(40),
					resolvedSetupCommand: null,
				}),
			).toThrow();
		});

		it("rejects a resolvedBaseSha that isn't a full commit SHA", () => {
			const intent = beginQuickDispatchIntent(input);
			expect(() =>
				pinQuickDispatchIntentResolution(intent.intentId, {
					resolvedName: "fix-sidebar-flicker",
					resolvedBaseSha: "not-a-sha",
					resolvedSetupCommand: null,
				}),
			).toThrow();
		});

		it("throws when the intent doesn't exist", () => {
			expect(() =>
				pinQuickDispatchIntentResolution("qd_missing", {
					resolvedName: "x",
					resolvedBaseSha: "b".repeat(40),
					resolvedSetupCommand: null,
				}),
			).toThrow();
		});
	});
});
