import { describe, expect, it } from "vitest";
import {
	WORKSPACE_PERFORMANCE_PROVIDERS,
	workspacePerformanceProviderForCell,
} from "./providers";

describe("workspace performance providers", () => {
	it("shares the provider order and resize screen model", () => {
		expect(WORKSPACE_PERFORMANCE_PROVIDERS).toMatchObject([
			{ id: "claude", title: "Claude Code", resizeBuffer: "alternate" },
			{ id: "codex", title: "Codex", resizeBuffer: "normal" },
		]);
	});

	it("balances providers deterministically across fixture cells", () => {
		expect(
			[1, 2, 3].map(
				(pane) => workspacePerformanceProviderForCell(1, pane).id,
			),
		).toEqual(["claude", "codex", "claude"]);
	});
});
