// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useSpaces } from "@/components/spaces/useSpaces";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { useStore } from "@/store";
import { hmuxSessionSummaryFixture } from "@/test/agentFixtures";

const initial = useStore.getState();
const key = hmuxSessionMetadataKey("workspace-1", "session-1");

function seed() {
	useStore.setState({
		spaces: [{ id: "desk-1", name: "One" }],
		activeSpaceId: "desk-1",
		layouts: {
			"desk-1": {
				panels: {
					"term:one": {
						contentComponent: "terminal",
						params: {
							sessionId: "session-1",
							binding: {
								schemaVersion: 1,
								runtime: "hmux_standalone_v1",
								source: "local",
								hostId: "local",
								workspaceId: "workspace-1",
								sessionId: "session-1",
							},
						},
					},
				},
			},
		},
		hmuxSessionMetadata: {
			[key]: hmuxSessionSummaryFixture({
				sessionName: "First",
				hostBuildVersion: "build-1",
			}),
		},
	});
}

afterEach(() => {
	cleanup();
	useStore.setState(initial, true);
});

describe("Spaces metadata subscription", () => {
	it("does not traverse unchanged metadata for unrelated store publications", () => {
		seed();
		let reads = 0;
		const metadata = useStore.getState().hmuxSessionMetadata;
		useStore.setState({
			hmuxSessionMetadata: new Proxy(metadata, {
				ownKeys(target) {
					reads += 1;
					return Reflect.ownKeys(target);
				},
			}),
		});
		const hook = renderHook(() => useSpaces());
		const rows = hook.result.current;
		reads = 0;
		act(() => {
			for (let index = 0; index < 32; index += 1) {
				useStore.getState().requestTerminalRefresh("unrelated-pane");
			}
		});
		expect(hook.result.current).toBe(rows);
		expect(reads).toBe(0);
	});

	it("keeps output-only updates quiet and follows names, builds, removal and reconnect", () => {
		seed();
		const hook = renderHook(() => useSpaces());
		const rows = hook.result.current;
		expect(rows[0]).toMatchObject({
			hmuxSessionName: "First",
			hostBuild: "build-1",
		});
		act(() =>
			useStore.getState().setHmuxSessionMetadata({
				...useStore.getState().hmuxSessionMetadata[key],
				outputSeq: "2",
			}),
		);
		expect(hook.result.current).toBe(rows);
		act(() =>
			useStore.getState().setHmuxSessionMetadata({
				...useStore.getState().hmuxSessionMetadata[key],
				sessionName: "Second",
				hostBuildVersion: "build-2",
			}),
		);
		expect(hook.result.current[0]).toMatchObject({
			hmuxSessionName: "Second",
			hostBuild: "build-2",
		});
		act(() => useStore.setState({ hmuxSessionMetadata: {} }));
		expect(hook.result.current[0]).toMatchObject({
			hmuxSessionName: undefined,
			hostBuild: undefined,
		});
		act(() =>
			useStore.getState().setHmuxSessionMetadata(
				hmuxSessionSummaryFixture({
					sessionName: "Reconnected",
					hostBuildVersion: "build-3",
					terminalEpoch: "epoch-2",
				}),
			),
		);
		expect(hook.result.current[0]).toMatchObject({
			hmuxSessionName: "Reconnected",
			hostBuild: "build-3",
		});
	});
});
