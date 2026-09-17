import { describe, expect, it } from "vitest";
import { buildOnboardingImportDraft } from "@/lib/onboarding/onboardingImportDraft";
import {
	beginOnboardingImportJournal,
	completeOnboardingImportJournal,
	discardOnboardingImportJournal,
	readOnboardingImportJournal,
	type OnboardingImportJournalStorage,
} from "@/lib/onboarding/onboardingImportJournal";

function storage(): OnboardingImportJournalStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

function draft() {
	return buildOnboardingImportDraft({
		total: 1,
		groups: [
			{
				id: "repo:dure",
				name: "HebbianIDE",
				cwd: "/repo",
				items: [
					{
						key: "codex:one",
						conversationId: "conversation-one",
						title: "One",
						mtime: 1,
						provider: "codex",
						cwd: "/repo",
						workspaceRoot: "/repo",
						groupIdentity: "repo:dure",
						defaultSelected: true,
						executionLocation: "local",
					},
				],
			},
		],
	});
}

describe("onboarding import journal", () => {
	it("allocates independent pane IDs once before import effects", () => {
		const memory = storage();
		const first = beginOnboardingImportJournal(draft(), {}, memory);
		expect(first.paneIds).toEqual([
			expect.stringMatching(/^pane-[A-Za-z0-9_-]+$/),
		]);
		expect(first.paneIds).not.toEqual(first.agentIds);
		expect(first.paneIds).not.toEqual(first.desktopIds);
		expect(readOnboardingImportJournal(memory)?.paneIds).toEqual(first.paneIds);
		expect(beginOnboardingImportJournal(draft(), {}, memory).paneIds).toEqual(
			first.paneIds,
		);
	});

	it("normalizes absent legacy pane IDs without rewriting the journal", () => {
		const memory = storage();
		const { paneIds: _paneIds, ...legacy } = beginOnboardingImportJournal(
			draft(),
			{},
			memory,
		);
		const raw = JSON.stringify(legacy);
		memory.setItem("dure:first-run-session-import:v1", raw);
		expect(readOnboardingImportJournal(memory)?.paneIds).toEqual(
			legacy.agentIds.map((id) => `agent:${id}`),
		);
		expect(beginOnboardingImportJournal(draft(), {}, memory).paneIds).toEqual(
			legacy.agentIds.map((id) => `agent:${id}`),
		);
		expect(memory.getItem("dure:first-run-session-import:v1")).toBe(raw);
	});

	it.each(
		[null, [], [42], [""], ["pane-\ninvalid"], ["x".repeat(513)]].map(
			(paneIds) => ({ paneIds }),
		),
	)(
		"preserves malformed explicit pane IDs instead of issuing another import: $paneIds",
		({ paneIds }) => {
			const memory = storage();
			const journal = beginOnboardingImportJournal(draft(), {}, memory);
			const raw = JSON.stringify({ ...journal, paneIds });
			memory.setItem("dure:first-run-session-import:v1", raw);
			expect(readOnboardingImportJournal(memory)).toBeUndefined();
			expect(() => beginOnboardingImportJournal(draft(), {}, memory)).toThrow(
				"onboarding import journal is invalid",
			);
			expect(memory.getItem("dure:first-run-session-import:v1")).toBe(raw);
		},
	);

	it("does not replace an unreadable journal with new identities", () => {
		const memory = storage();
		memory.setItem("dure:first-run-session-import:v1", "{incomplete");
		expect(() => beginOnboardingImportJournal(draft(), {}, memory)).toThrow(
			"onboarding import journal is invalid",
		);
		expect(memory.getItem("dure:first-run-session-import:v1")).toBe(
			"{incomplete",
		);
	});

	it("rejects duplicate explicit pane IDs at journal ingress", () => {
		const memory = storage();
		const input = draft();
		input.desktops[0].panes = [
			...input.desktops[0].panes,
			{
				...input.desktops[0].panes[0],
				key: "codex:two",
				conversationId: "conversation-two",
			},
		];
		const journal = beginOnboardingImportJournal(input, {}, memory);
		const raw = JSON.stringify({
			...journal,
			paneIds: ["pane-duplicate", "pane-duplicate"],
		});
		memory.setItem("dure:first-run-session-import:v1", raw);
		expect(readOnboardingImportJournal(memory)).toBeUndefined();
		expect(() => beginOnboardingImportJournal(input, {}, memory)).toThrow(
			"onboarding import journal is invalid",
		);
		expect(memory.getItem("dure:first-run-session-import:v1")).toBe(raw);
	});

	it("recovers the exact planned IDs and keeps the completed receipt", () => {
		const memory = storage();
		const first = beginOnboardingImportJournal(
			draft(),
			{ reusableDesktopId: "desk-first" },
			memory,
		);
		const recovered = beginOnboardingImportJournal(draft(), {}, memory);
		expect(recovered).toEqual(first);
		expect(recovered.desktopIds).toEqual(["desk-first"]);

		completeOnboardingImportJournal(
			first,
			{
				projectIds: ["project-one"],
				desktopIds: first.desktopIds,
				agentIds: first.agentIds,
				committedAtMs: 2,
			},
			memory,
		);
		expect(readOnboardingImportJournal(memory)).toMatchObject({
			status: "complete",
			receipt: { committedAtMs: 2 },
		});
	});

	it("keeps a historical ten-pane v1 journal recoverable", () => {
		const memory = storage();
		const initial = draft();
		const pane = initial.desktops[0].panes[0];
		const historical = {
			...initial,
			desktops: [
				{
					...initial.desktops[0],
					panes: Array.from({ length: 10 }, (_, index) => ({
						...pane,
						key: `codex:legacy-${index}`,
						conversationId: `conversation-legacy-${index}`,
					})),
				},
			],
			discoveredCount: 10,
		};

		beginOnboardingImportJournal(historical, {}, memory);
		expect(
			readOnboardingImportJournal(memory)?.draft.desktops[0].panes,
		).toHaveLength(10);
	});

	it("rejects an unbounded repository display name from storage", () => {
		const memory = storage();
		const planned = beginOnboardingImportJournal(draft(), {}, memory);
		memory.setItem(
			"dure:first-run-session-import:v1",
			JSON.stringify({
				...planned,
				draft: {
					...planned.draft,
					desktops: [
						{
							...planned.draft.desktops[0],
							sourceGroupName: "x".repeat(257),
						},
					],
				},
			}),
		);

		expect(readOnboardingImportJournal(memory)).toBeUndefined();
	});

	it("rejects malformed host metadata before repository summaries read it", () => {
		const memory = storage();
		const planned = beginOnboardingImportJournal(draft(), {}, memory);
		memory.setItem(
			"dure:first-run-session-import:v1",
			JSON.stringify({
				...planned,
				draft: {
					...planned.draft,
					desktops: [
						{
							...planned.draft.desktops[0],
							panes: [
								{
									...planned.draft.desktops[0].panes[0],
									executionLocation: "ssh",
									hostId: 42,
								},
							],
						},
					],
				},
			}),
		);

		expect(readOnboardingImportJournal(memory)).toBeUndefined();
	});

	it("discard는 저널을 지워 잠금을 풀고, 새 begin이 새 applyId를 받는다", () => {
		const memory = storage();
		const first = beginOnboardingImportJournal(draft(), {}, memory);
		discardOnboardingImportJournal(memory);
		expect(readOnboardingImportJournal(memory)).toBeUndefined();
		const second = beginOnboardingImportJournal(draft(), {}, memory);
		expect(second.applyId).not.toBe(first.applyId);
	});
});
