// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	type AgentPaneAttentionApi,
	useAgentPaneAttentionAck,
} from "@/components/agents/useAgentPaneAttentionAck";

function paneApi() {
	let activeListener: (() => void) | undefined;
	let visibilityListener: (() => void) | undefined;
	const activeDispose = vi.fn();
	const visibilityDispose = vi.fn();
	const api: AgentPaneAttentionApi = {
		isActive: true,
		isVisible: true,
		onDidActiveChange: vi.fn((listener) => {
			activeListener = listener;
			return { dispose: activeDispose };
		}),
		onDidVisibilityChange: vi.fn((listener) => {
			visibilityListener = listener;
			return { dispose: visibilityDispose };
		}),
	};
	return {
		api,
		activeDispose,
		visibilityDispose,
		activeListener: () => activeListener,
		visibilityListener: () => visibilityListener,
	};
}

describe("useAgentPaneAttentionAck", () => {
	beforeEach(() => {
		useAgentAttention.setState({
			episodes: { "agent-1": 3 },
			acks: {},
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("acknowledges on focus and disposes both pane subscriptions", () => {
		const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		const pane = paneApi();
		const rendered = renderHook(() =>
			useAgentPaneAttentionAck("agent-1", pane.api),
		);
		expect(useAgentAttention.getState().acks["agent-1"]).toBeUndefined();

		focus.mockReturnValue(true);
		act(() => window.dispatchEvent(new Event("focus")));

		expect(useAgentAttention.getState().acks["agent-1"]).toBe(3);
		expect(pane.activeListener()).toBeTypeOf("function");
		expect(pane.visibilityListener()).toBeTypeOf("function");
		rendered.unmount();
		expect(pane.activeDispose).toHaveBeenCalledOnce();
		expect(pane.visibilityDispose).toHaveBeenCalledOnce();
	});
});
