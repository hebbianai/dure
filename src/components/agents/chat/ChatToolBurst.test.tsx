// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDisclosureState } from "@/components/agents/chat/ChatDisclosure";
import { ChatToolBurst } from "@/components/agents/chat/ChatToolBurst";
import type { AgentChatProjectedRow } from "@/lib/agents/chat/agentChatProjection";
import type { AgentTimelineItemBodyV1 } from "@/lib/agents/chat/agentConversationContract";
import { editDiffRows } from "@/lib/agents/chat/fileEditDiff";
import { t } from "@/lib/i18n";

vi.mock("@/lib/agents/chat/fileEditDiff", { spy: true });

function toolRow(
	body: Extract<AgentTimelineItemBodyV1, { type: "tool" }>,
	index = 1,
) {
	const row: AgentChatProjectedRow = {
		key: `row-${index}`,
		revision: "rev-1",
		timeline: {
			cursor: { epoch: "timeline-1", sequence: index },
			item: {
				itemId: `item-${index}`,
				turnId: "turn-1",
				clientMessageId: null,
				providerMessageId: null,
				body,
				createdAtMs: 1,
			},
		},
	};
	return [row];
}

function editRows(state: "completed" | "failed") {
	return Array.from({ length: 16 }, (_, index) =>
		toolRow(
			{
				type: "tool",
				toolCallId: `call-${index}`,
				name: "Edit",
				state,
				input: {
					file_path: `src/file-${index}.ts`,
					old_string: Array.from(
						{ length: 80 },
						(_, line) => `old ${index}:${line}`,
					).join("\n"),
					new_string: Array.from(
						{ length: 80 },
						(_, line) => `new ${index}:${line}`,
					).join("\n"),
				},
				output: null,
			},
			index,
		),
	).flat();
}

async function expandBurst(container: HTMLElement) {
	fireEvent.click(container.querySelector("summary")!);
	await waitFor(() =>
		expect(container.querySelector("details details")).not.toBeNull(),
	);
}

describe("ChatToolBurst file changes", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => cleanup());

	it("mounts failed edit rows only while their burst is expanded and retains manual disclosure state", async () => {
		const state = new Map<string, boolean>();
		const content = (rows: AgentChatProjectedRow[]) => (
			<ChatDisclosureState value={state}>
				<ChatToolBurst rows={rows} shimmerToolKey={null} />
			</ChatDisclosureState>
		);
		const rows = editRows("failed");
		const view = render(content(rows));
		const summary = view.container.querySelector("summary")!;
		expect(summary.textContent).toContain(
			t("agents.chat.workFailedMany", { count: 16 }),
		);
		expect(editDiffRows).not.toHaveBeenCalled();
		expect(view.container.querySelector("details details")).toBeNull();

		fireEvent.click(summary);
		await screen.findByText("old 15:0");
		expect(editDiffRows).toHaveBeenCalledTimes(16);
		const first = view.container.querySelector("details details")!;
		fireEvent.click(first.querySelector("summary")!);
		await waitFor(() => expect(screen.queryByText("old 0:0")).toBeNull());
		fireEvent.click(summary);
		await waitFor(() =>
			expect(view.container.querySelector("details details")).toBeNull(),
		);
		vi.mocked(editDiffRows).mockClear();

		const updated = rows.map((row) => ({
			...row,
			revision: "rev-2",
			timeline: {
				...row.timeline,
				item: {
					...row.timeline.item,
					body: {
						...row.timeline.item.body,
						input: {
							file_path: `src/latest-${row.key}.ts`,
							old_string: `previous ${row.key}`,
							new_string: `latest ${row.key}`,
						},
					},
				},
			},
		}));
		view.rerender(content(updated));
		expect(editDiffRows).not.toHaveBeenCalled();
		expect(view.container.querySelector("details details")).toBeNull();
		fireEvent.click(summary);
		await screen.findByText("latest row-15");
		expect(editDiffRows).toHaveBeenCalledTimes(15);
		expect(screen.queryByText("latest row-0")).toBeNull();
		expect(screen.queryByText("old 15:0")).toBeNull();
		fireEvent.click(view.container.querySelector("details details summary")!);
		await screen.findByText("latest row-0");
		expect(editDiffRows).toHaveBeenCalledTimes(16);
	});

	it("does no diff work for 16 collapsed edits and renders only the opened call", async () => {
		const rows = editRows("completed");
		const view = render(<ChatToolBurst rows={rows} shimmerToolKey={null} />);
		expect(editDiffRows).not.toHaveBeenCalled();
		expect(screen.queryByText("old 0:0")).toBeNull();
		await expandBurst(view.container);
		expect(editDiffRows).not.toHaveBeenCalled();
		const first = screen.getByText("src/file-0.ts").closest("details")!;
		fireEvent.click(first.querySelector("summary")!);
		await screen.findByText("old 0:0");
		expect(editDiffRows).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("old 1:0")).toBeNull();

		fireEvent.click(first.querySelector("summary")!);
		await waitFor(() => expect(screen.queryByText("old 0:0")).toBeNull());
		const updated = rows.map((row) => ({ ...row, revision: "rev-2" }));
		view.rerender(<ChatToolBurst rows={updated} shimmerToolKey={null} />);
		expect(editDiffRows).toHaveBeenCalledTimes(1);
		fireEvent.click(first.querySelector("summary")!);
		await screen.findByText("new 0:0");
		expect(editDiffRows).toHaveBeenCalledTimes(2);
	});

	it("opens new failures and respects a manually collapsed failure on later snapshots", async () => {
		const body = {
			type: "tool" as const,
			toolCallId: "call-1",
			name: "Bash",
			state: "running" as const,
			input: { command: "pnpm test" },
			output: null,
		};
		const view = render(
			<ChatToolBurst rows={toolRow(body)} shimmerToolKey="row-1" />,
		);
		await expandBurst(view.container);
		const failed = toolRow({ ...body, state: "failed", output: "Test failed" });
		view.rerender(<ChatToolBurst rows={failed} shimmerToolKey={null} />);
		expect(
			await screen.findByText(/\$ pnpm test\n\nTest failed/, {
				normalizer: (text) => text,
			}),
		).toBeTruthy();
		const details =
			view.container.querySelector<HTMLDetailsElement>("details details")!;
		expect(details.open).toBe(true);
		fireEvent.click(details.querySelector("summary")!);
		await waitFor(() => expect(view.container.querySelector("pre")).toBeNull());
		view.rerender(
			<ChatToolBurst
				rows={failed.map((row) => ({ ...row, revision: "rev-2" }))}
				shimmerToolKey={null}
			/>,
		);
		expect(details.open).toBe(false);
		expect(view.container.querySelector("pre")).toBeNull();
	});

	it("restores tool bodies and manual collapse when a virtual row remounts", async () => {
		const state = new Map<string, boolean>([
			["burst:row-1", true],
			["tool:row-1", true],
		]);
		const rows = toolRow({
			type: "tool",
			toolCallId: "call-1",
			name: "Bash",
			state: "failed",
			input: { command: "pnpm test" },
			output: "Retained failure",
		});
		const content = (
			<ChatDisclosureState value={state}>
				<ChatToolBurst rows={rows} shimmerToolKey={null} />
			</ChatDisclosureState>
		);
		const view = render(content);
		expect(screen.getByText(/Retained failure/)).toBeTruthy();
		const details = view.container.querySelector("details details")!;
		fireEvent.click(details.querySelector("summary")!);
		await waitFor(() => expect(view.container.querySelector("pre")).toBeNull());
		view.unmount();
		const remounted = render(content);
		expect(
			remounted.container.querySelector("details details[open]"),
		).toBeNull();
		expect(remounted.container.querySelector("pre")).toBeNull();
	});

	it("keeps an expanded live result current and uses the latest snapshot when reopened", async () => {
		const body = {
			type: "tool" as const,
			toolCallId: "call-1",
			name: "Bash",
			state: "running" as const,
			input: { command: "pnpm test" },
			output: "First result",
		};
		const view = render(
			<ChatToolBurst rows={toolRow(body)} shimmerToolKey="row-1" />,
		);
		await expandBurst(view.container);
		const details =
			view.container.querySelector<HTMLDetailsElement>("details details")!;
		fireEvent.click(details.querySelector("summary")!);
		await screen.findByText(/First result/);
		const completed = toolRow({
			...body,
			state: "completed",
			output: "Completed result",
		});
		view.rerender(<ChatToolBurst rows={completed} shimmerToolKey={null} />);
		expect(details.open).toBe(true);
		expect(screen.getByText(/Completed result/)).toBeTruthy();
		fireEvent.click(details.querySelector("summary")!);
		await waitFor(() => expect(view.container.querySelector("pre")).toBeNull());
		const latest = toolRow({
			...body,
			state: "completed",
			output: "Latest result",
		}).map((row) => ({ ...row, revision: "rev-3" }));
		view.rerender(<ChatToolBurst rows={latest} shimmerToolKey={null} />);
		expect(view.container.querySelector("pre")).toBeNull();
		fireEvent.click(details.querySelector("summary")!);
		expect(await screen.findByText(/Latest result/)).toBeTruthy();
		expect(screen.queryByText(/Completed result/)).toBeNull();
	});

	it("shows what an edit changed instead of the provider's payload", async () => {
		const view = render(
			<ChatToolBurst
				rows={toolRow({
					type: "tool",
					toolCallId: "call-1",
					name: "Edit",
					state: "completed",
					input: {
						file_path: "src/a.ts",
						old_string: "const a = 1;\nconst b = 2;",
						new_string: "const a = 1;\nconst b = 3;",
					},
					output: null,
				})}
				shimmerToolKey={null}
			/>,
		);
		await expandBurst(view.container);
		fireEvent.click(view.container.querySelector("details details summary")!);
		expect(await screen.findByText("const b = 2;")).toBeTruthy();
		expect(screen.getByText("const b = 3;")).toBeTruthy();
		// The unchanged line stays as context, and the raw JSON is gone.
		expect(screen.getByText("const a = 1;")).toBeTruthy();
		expect(screen.queryByText(/"old_string"/)).toBeNull();
	});

	it("names each file of a codex patch and states collapsed lines", async () => {
		const context = Array.from({ length: 12 }, (_, index) => ` keep ${index}`);
		const view = render(
			<ChatToolBurst
				rows={toolRow({
					type: "tool",
					toolCallId: "call-1",
					name: "fileChange",
					state: "completed",
					input: {
						changes: [
							{
								path: "/r/a.rs",
								kind: "update",
								diff: "@@ -1 +1 @@\n-old\n+new",
							},
							{
								path: "/r/b.rs",
								kind: "update",
								diff: ["@@ -1,13 +1,13 @@", ...context, "-gone"].join("\n"),
							},
						],
					},
					output: null,
				})}
				shimmerToolKey={null}
			/>,
		);
		await expandBurst(view.container);
		fireEvent.click(view.container.querySelector("details details summary")!);
		expect(await screen.findByText("/r/a.rs")).toBeTruthy();
		expect(screen.getByText("/r/b.rs")).toBeTruthy();
		expect(
			screen.getByText(t("agents.chat.diffUnchanged", { count: 6 })),
		).toBeTruthy();
	});

	it("keeps the raw payload when the change is not in it", async () => {
		const view = render(
			<ChatToolBurst
				rows={toolRow({
					type: "tool",
					toolCallId: "call-1",
					name: "fileChange",
					state: "completed",
					input: { changes: [{ path: "/r/a.rs", kind: "update" }] },
					output: null,
				})}
				shimmerToolKey={null}
			/>,
		);
		await expandBurst(view.container);
		fireEvent.click(view.container.querySelector("details details summary")!);
		expect(await screen.findByText(/"path"/)).toBeTruthy();
	});
});
