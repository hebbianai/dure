import { beforeEach, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";

const ports = vi.hoisted(() => ({
	resolve: vi.fn(),
	validate: vi.fn(),
	append: vi.fn(),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
	getAllWebviewWindows: vi.fn(),
}));
vi.mock("@/lib/workspace/window/mountedPaneWindow", () => ({
	resolveMountedPaneWindow: ports.resolve,
	revalidateMountedPaneWindow: ports.validate,
}));
vi.mock("@/lib/workspace/window/agentSessionWindowCommand", () => ({
	requestAgentSessionDraftAppend: ports.append,
}));
const profile = {
	schemaVersion: 1 as const,
	kind: "structured_protocol" as const,
	backendProfileId: "local",
	interactionSessionId: "interaction-window",
};
const agent = () =>
	managedAgentFixture({
		id: "chat-window",
		runtimeBinding: undefined,
		interactionProfile: profile,
	});
const owner = {
	schemaVersion: 1,
	paneId: "agent:chat-window",
	desktopId: "chat-space",
	dockviewId: "dock-2",
	windowLabel: "win-100-2",
	windowGeneration: "generation-2",
};
const image = { fileName: "element.png", dataB64: "cG5n" };
beforeEach(() => {
	ports.resolve.mockReset().mockResolvedValue(owner);
	ports.validate.mockReset();
	ports.append.mockReset().mockResolvedValue({ kind: "drafted" });
	useStore.setState({
		agents: [agent()],
		projects: [
			{
				id: agent().projectId,
				name: "Chat",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		chatDrafts: {},
	});
});
it("delivers a capture through the owning window instead of creating a hidden local draft", async () => {
	await deliverCaptureToAgent("chat-window", "한글 캡처", [
		{ kind: "bytes", file: image },
	]);
	expect(useStore.getState().chatDrafts).toEqual({});
	expect(ports.append).toHaveBeenCalledTimes(1);
	expect(ports.append).toHaveBeenCalledWith(
		expect.objectContaining({
			owner,
			text: "한글 캡처",
			attachments: [image],
			target: expect.objectContaining({
				identity: {
					agentId: "chat-window",
					backendProfileId: "local",
					interactionSessionId: "interaction-window",
				},
			}),
		}),
	);
});
it("retains an uncertain remote delivery error without creating a fallback local draft", async () => {
	ports.append.mockRejectedValueOnce(
		new Error("source window command response timed out"),
	);
	await expect(
		deliverCaptureToAgent("chat-window", "Capture"),
	).rejects.toMatchObject({ code: "write_failed" });
	expect(useStore.getState().chatDrafts).toEqual({});
	expect(ports.append).toHaveBeenCalledTimes(1);
});
