// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConversationMenu } from "@/components/agents/AgentConversationControls";

afterEach(cleanup);

describe("AgentConversationMenu", () => {
	it("keeps the active conversation disabled and delegates another exact id", async () => {
		const onSwitch = vi.fn().mockResolvedValue(undefined);
		const rendered = render(
			<AgentConversationMenu
				activeConversationId="conversation-live"
				conversations={[
					{ id: "conversation-live", title: "Current", mtime: 1 },
					{ id: "conversation-history", title: "Previous", mtime: 0 },
				]}
				disabled={false}
				disabledTitle="disabled"
				freshLabel="새 pane에서 새 대화"
				onError={vi.fn()}
				onLoad={vi.fn()}
				onSwitch={onSwitch}
				resumeLabel="새 pane에서 이어가기"
				triggerTitle="최근 작업 / 새 pane에서 이어가기"
			/>,
		);

		fireEvent.pointerDown(
			rendered.getByRole("button", {
				name: "최근 작업 / 새 pane에서 이어가기",
			}),
			{ button: 0, ctrlKey: false },
		);
		expect(
			await rendered.findByRole("menuitem", {
				name: "새 pane에서 새 대화",
			}),
		).toBeTruthy();
		const current = await rendered.findByRole("menuitem", { name: /Current/ });
		expect(current.hasAttribute("data-disabled")).toBe(true);

		const previous = rendered.getByRole("menuitem", {
			name: /Previous.*새 pane에서 이어가기/,
		});
		fireEvent.click(previous);
		await waitFor(() =>
			expect(onSwitch).toHaveBeenCalledWith({
				kind: "id",
				id: "conversation-history",
			}),
		);
	});
});
