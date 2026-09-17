// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
	type PaneParams,
	usePaneChromeState,
} from "@/components/workspace/usePaneChromeState";
import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";

const initial = useStore.getState();
afterEach(() => {
	cleanup();
	useStore.setState(initial, true);
});

function seeded() {
	const currentBinding = managedBindingFixture({
		sessionId: "current-runtime",
	});
	const previousBinding = managedBindingFixture({
		sessionId: "previous-runtime",
	});
	useStore.setState({
		agents: [
			agentFixture({
				id: "current",
				sessionId: "current-runtime",
				runtimeBinding: currentBinding,
			}),
			agentFixture({
				id: "previous",
				sessionId: "previous-runtime",
				runtimeBinding: previousBinding,
			}),
		],
	});
	return { currentBinding, previousBinding };
}
const common = {
	desktopId: "one",
	paneRuntimeId: "one:slot",
	pinKey: "one:slot",
	includeSwitchCandidates: false,
};

describe.each(["slot", "agent:previous", "launcher:previous"])(
	"chrome target reference in %s",
	(panelId) => {
		it("shows the explicitly referenced Agent and its runtime", () => {
			const { currentBinding } = seeded();
			const props = {
				...common,
				panelId,
				component: "agent",
				params: { agentRef: { agentId: "current" } },
			};
			const hook = renderHook(() => usePaneChromeState(props));
			expect(hook.result.current.agent?.id).toBe("current");
			expect(hook.result.current.hmuxBinding).toEqual(currentBinding);
			expect(hook.result.current.sessionId).toBe("current-runtime");
		});
		it("uses terminal content even when its initial ID resembled an Agent", () => {
			const { currentBinding } = seeded();
			const props = {
				...common,
				panelId,
				component: "terminal",
				params: { binding: currentBinding, agentRef: { agentId: "previous" } },
			};
			const hook = renderHook(() => usePaneChromeState(props));
			expect(hook.result.current.agent).toBeUndefined();
			expect(hook.result.current.hmuxBinding).toEqual(currentBinding);
		});
		it.each([null, {}, { agentId: "" }])(
			"does not use copied runtime params when an explicit Agent reference is invalid: %j",
			(agentRef) => {
				const { currentBinding } = seeded();
				const props = {
					...common,
					panelId,
					component: "agent",
					params: {
						agentRef,
						binding: currentBinding,
						sessionId: "copied-runtime",
					} as PaneParams,
				};
				const hook = renderHook(() => usePaneChromeState(props));
				expect(hook.result.current.agent).toBeUndefined();
				expect(hook.result.current.hmuxBinding).toBeUndefined();
				expect(hook.result.current.sessionId).toBeUndefined();
			},
		);
	},
);
