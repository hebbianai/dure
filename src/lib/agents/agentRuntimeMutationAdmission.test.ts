// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentRuntimePaneAction } from "@/lib/agents/agentRuntimePaneAction";
import { projectAgentRuntimeTransition } from "@/lib/agents/agentRuntimeStoreProjector";
import {
	switchAgentRuntimeCredential,
	transitionAgentRuntime,
} from "@/lib/agents/agentRuntimeTransitionAction";
import type { TauriCoreModule } from "@/lib/ipc/core";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { durableAppStorage, useStore } from "@/store";
import { createRuntimeMutationAdmissionFixture } from "@/test/agentRuntimeMutationAdmissionFixtures";

const transport = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<TauriCoreModule>()),
	invoke: transport.invoke,
}));

afterEach(async () => {
	await durableAppStorage.flush();
	transport.invoke.mockReset();
});

describe("runtime mutation source admission", () => {
	it.each([
		[
			"launch selection",
			() =>
				transitionAgentRuntime({
					agentId: "agent-1",
					targetInteractionProfile: "preserve",
					targetLaunchSelectionUpdate: (source) => ({
						...source,
						model: "sonnet",
					}),
				}),
		],
		[
			"named pane",
			() =>
				runAgentRuntimePaneAction((sourceStopPolicy) =>
					transitionAgentRuntime({
						agentId: "agent-1",
						targetInteractionProfile: "native_cli",
						sourceStopPolicy,
					}).then(() => undefined),
				),
		],
		[
			"credential switch",
			() => switchAgentRuntimeCredential("agent-1", null),
		],
	] as const)(
		"refuses a stale source for %s before mutation or credential preparation",
		async (_, action) => {
			const fixture = createRuntimeMutationAdmissionFixture();
			transport.invoke.mockImplementation(fixture.handleRequest);
			useStore.setState(fixture.state);
			await expect(action()).rejects.toThrow(
				"client_agent_runtime_transition_conflict",
			);
			expect(fixture.requests).toEqual(["agent_runtime.projection.inspect"]);
			expect(useStore.getState().agents[0]).toBe(fixture.agent);
			expect(
				useStore.getState().agentRuntimeLaunchPresentation["agent-1"],
			).toBe(fixture.current);
		},
	);

	it("still converges a late committed observation without erasing newer user work", async () => {
		const fixture = createRuntimeMutationAdmissionFixture();
		transport.invoke.mockImplementation(fixture.handleRequest);
		useStore.setState(fixture.state);
		const observation = await createDureAgentRuntimeClient({
			profileId: "local",
		}).inspect("agent-1");
		if (observation.state !== "stable")
			throw new Error("Expected stable fixture");
		expect(projectAgentRuntimeTransition("agent-1", observation)).toBe(
			fixture.current,
		);
		expect(useStore.getState().agents[0]).toBe(fixture.agent);
		expect(fixture.requests).toEqual(["agent_runtime.projection.inspect"]);
	});

	it.each([2, 3])(
		"admits source revision %s against revision 2",
		async (revision) => {
			const fixture = createRuntimeMutationAdmissionFixture(revision);
			transport.invoke.mockImplementation(fixture.handleRequest);
			useStore.setState(fixture.state);
			await expect(
				transitionAgentRuntime({
					agentId: "agent-1",
					targetInteractionProfile: "native_cli",
				}),
			).resolves.toMatchObject({ selectionRevision: revision + 1 });
			expect(fixture.requests).toEqual([
				"agent_runtime.projection.inspect",
				"agent_runtime.transition",
			]);
		},
	);
});
