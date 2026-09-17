import { beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { handleExactHmuxInput, handleManagedHmuxInput } from "./cliHmuxInput";

const mocks = vi.hoisted(() => ({ claim: vi.fn(), input: vi.fn() }));
vi.mock("./cliRequestBroker", () => ({ claimCliRequest: mocks.claim }));
vi.mock("@/lib/ipc", async (original) => {
	const real = await original<typeof import("@/lib/ipc")>();
	return { ...real, hmux: { ...real.hmux, commandInput: mocks.input } };
});
const fence = stopFenceFixture();
const target = {
	schemaVersion: 1,
	targetPanelId: "agent:agent-1",
	hostId: "local",
	sessionId: "session-1",
	workspaceId: "workspace-1",
};
beforeEach(() => {
	mocks.claim.mockReset().mockResolvedValue(true);
	mocks.input.mockReset().mockResolvedValue({
		terminalEpoch: fence.terminalEpoch,
		text: { recordId: "1", state: "written_to_pty" },
	});
	useStore.setState({
		agents: [
			managedAgentFixture({
				runtimeBinding: managedBindingFixture({ stopFence: fence }),
			}),
		],
		projects: [],
		sshHosts: [],
	});
});
for (const [kind, handle, params] of [
	[
		"name",
		handleManagedHmuxInput,
		{ name: "agent-1", text: "한글 초안", enter: false },
	],
	["exact", handleExactHmuxInput, { target, text: "한글 초안", enter: false }],
] as const) {
	it(`refuses ${kind} input if its generation is replaced while claiming the request`, async () => {
		mocks.claim.mockImplementationOnce(async () => {
			useStore.setState({
				agents: [
					managedAgentFixture({
						runtimeBinding: managedBindingFixture({
							stopFence: { ...fence, terminalEpoch: "replacement" },
						}),
					}),
				],
			});
			return true;
		});
		await expect(handle(params, "request-1")).resolves.toMatchObject({
			ok: false,
			error: { code: "pane_changed" },
		});
		expect(mocks.claim).toHaveBeenCalledTimes(1);
		expect(mocks.input).not.toHaveBeenCalled();
		// A new explicit request is prepared against the replacement generation.
		await expect(handle(params, "request-2")).resolves.toMatchObject({
			ok: true,
		});
		expect(mocks.input).toHaveBeenCalledExactlyOnceWith({
			sessionId: "session-1",
			workspaceId: "workspace-1",
			expectedFence: { ...fence, terminalEpoch: "replacement" },
			text: "한글 초안",
			submit: false,
		});
	});
	it(`does not dispatch ${kind} input when another client owns the claim`, async () => {
		mocks.claim.mockResolvedValueOnce(false);
		await expect(handle(params, "request-1")).resolves.toBeNull();
		expect(mocks.input).not.toHaveBeenCalled();
	});
}
