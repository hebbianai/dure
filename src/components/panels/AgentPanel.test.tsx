// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "@/components/panels/AgentPanel";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { t } from "@/lib/i18n";
import { normalizePersistedPaneDefinition } from "@/lib/workspace/layout/persistedPaneLayout";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	agent: undefined as Agent | undefined,
	useAgentPanelState: vi.fn(),
	nativeProps: undefined as Record<string, unknown> | undefined,
	structuredProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/components/panels/useAgentPanelState", () => ({
	useAgentPanelState: mocks.useAgentPanelState,
}));

vi.mock("@/components/panels/NativeAgentPanel", () => ({
	NativeAgentPanel: (props: { agent: Agent }) => {
		mocks.nativeProps = props;
		return (
			<div data-agent-id={props.agent.id} data-testid="native-agent-panel" />
		);
	},
}));

vi.mock("@/components/panels/StructuredAgentPanel", () => ({
	StructuredAgentPanel: (props: { agent: Agent }) => {
		mocks.structuredProps = props;
		return (
			<div
				data-agent-id={props.agent.id}
				data-testid="structured-agent-panel"
			/>
		);
	},
}));

function props(
	panelId = "agent:agent-1",
	params: Record<string, unknown> = { agentRef: { agentId: "agent-1" } },
): AgentPanelDockProps {
	return {
		api: { id: panelId },
		params,
	} as unknown as AgentPanelDockProps;
}

function structuredAgent(): Agent {
	return agentFixture({
		id: "agent-1",
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		},
	});
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe("AgentPanel", () => {
	beforeEach(() => {
		mocks.agent = undefined;
		mocks.nativeProps = undefined;
		mocks.structuredProps = undefined;
		mocks.useAgentPanelState.mockReset();
		mocks.useAgentPanelState.mockImplementation(() => ({
			agent: mocks.agent,
			backendManaged: true,
			onStructuredRuntimeInvalidated: vi.fn(),
		}));
	});

	afterEach(cleanup);

	it.each(["pane:opaque", "agent:previous"])(
		"reads the explicit target of %s without renaming the pane",
		(paneId) => {
			mocks.agent = structuredAgent();
			render(
				<AgentPanel
					{...props(paneId, {
						agentRef: { agentId: "agent-1" },
						agentId: "stale",
					})}
				/>,
			);
			expect(mocks.useAgentPanelState).toHaveBeenCalledWith("agent-1", paneId);
		},
	);

	it.each([null, {}, { agentId: "" }])(
		"does not fall back to the old ID when the explicit target is unresolved (%j)",
		(agentRef) => {
			render(<AgentPanel {...props("agent:previous", { agentRef })} />);
			expect(mocks.useAgentPanelState).toHaveBeenCalledWith(
				"",
				"agent:previous",
			);
			expect(screen.getByText(t("common.unavailable"))).toBeTruthy();
		},
	);

	it("mounts a restored legacy reference without trusting copied runtime parameters", () => {
		mocks.agent = structuredAgent();
		const restored = normalizePersistedPaneDefinition("agent:agent-1", {
			contentComponent: "agent",
			params: {
					agentId: "agent-stale",
					binding: { sessionId: "session-stale" },
			},
		}) as { params: Record<string, unknown> };

		render(<AgentPanel {...props("agent:agent-1", restored.params)} />);

		expect(mocks.useAgentPanelState).toHaveBeenCalledWith(
			"agent-1",
			"agent:agent-1",
		);
		expect(
			screen
				.getByTestId("structured-agent-panel")
				.getAttribute("data-agent-id"),
		).toBe("agent-1");
		expect(mocks.structuredProps?.onRuntimeInvalidated).toBe(
			mocks.useAgentPanelState.mock.results[0]?.value
				.onStructuredRuntimeInvalidated,
		);
	});

	it("does not infer a mounted Agent from a missing reference", () => {
		render(<AgentPanel {...props("agent:agent-1", {})} />);
		expect(mocks.useAgentPanelState).toHaveBeenCalledWith("", "agent:agent-1");
		expect(screen.getByText(t("common.unavailable"))).toBeTruthy();
		expect(mocks.nativeProps).toBeUndefined();
		expect(mocks.structuredProps).toBeUndefined();
	});

	it("keeps a missing Agent pane visible without inspecting or deleting it", () => {
		render(<AgentPanel {...props()} />);

		expect(screen.getByText(t("common.unavailable"))).toBeTruthy();
	});

	it("routes a native Agent directly to its terminal surface", () => {
		mocks.agent = agentFixture({ id: "agent-1" });

		render(<AgentPanel {...props()} />);

		expect(
			screen.getByTestId("native-agent-panel").getAttribute("data-agent-id"),
		).toBe("agent-1");
	});

	it("owns one history action lease across Native and Structured child replacement", async () => {
		mocks.agent = agentFixture({ id: "agent-1" });
		const rendered = render(<AgentPanel {...props()} />);
		const lease = mocks.nativeProps?.historyActionLease as {
			readonly busy: boolean;
			run(action: () => Promise<void>): Promise<boolean>;
		};
		const pending = deferred<void>();
		let firstRun!: Promise<boolean>;
		act(() => {
			firstRun = lease.run(() => pending.promise);
		});
		await waitFor(() => expect(lease.busy).toBe(true));

		mocks.agent = structuredAgent();
		rendered.rerender(<AgentPanel {...props()} />);
		expect(mocks.structuredProps?.historyActionLease).toBe(lease);
		const duplicate = vi.fn().mockResolvedValue(undefined);
		await expect(lease.run(duplicate)).resolves.toBe(false);
		expect(duplicate).not.toHaveBeenCalled();

		await act(async () => pending.resolve());
		await expect(firstRun).resolves.toBe(true);
		await waitFor(() => expect(lease.busy).toBe(false));
	});

	it("does not promote a copied legacy agentId when the old pane ID has no locator", () => {
		render(<AgentPanel {...props("legacy-pane", { agentId: "agent-1" })} />);

		expect(mocks.useAgentPanelState).toHaveBeenCalledWith("", "legacy-pane");
		expect(screen.getByText(t("common.unavailable"))).toBeTruthy();
	});
});
