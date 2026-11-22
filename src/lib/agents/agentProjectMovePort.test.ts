import { expect, it, vi } from "vitest";

const move = vi.hoisted(() => ({
	prepareAgentProjectMove: vi.fn(async (_agentId: string) => ({
		projects: [],
		complete: true,
	})),
}));
vi.mock("./agentProjectMove", () => move);

import { localAgentProjectMovePort } from "./agentProjectMovePort";

it("prepares the pane's own Agent move in this window, on demand", async () => {
	const port = localAgentProjectMovePort("agent-1");
	expect(move.prepareAgentProjectMove).not.toHaveBeenCalled();

	await expect(port.prepare()).resolves.toMatchObject({ complete: true });
	expect(move.prepareAgentProjectMove).toHaveBeenCalledWith("agent-1");
});
