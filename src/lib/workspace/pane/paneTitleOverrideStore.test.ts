import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyAutomaticPaneTitle,
	normalizePaneTitleOverrides,
	renamePaneTitle,
	usePaneTitleOverrides,
} from "@/lib/workspace/pane/paneTitleOverrideStore";

describe("normalizePaneTitleOverrides", () => {
	it("keeps bounded title/fallback pairs and drops damaged entries", () => {
		expect(
			normalizePaneTitleOverrides({
				"agent:a": { title: " QA ", fallback: "repo" },
				blank: { title: "", fallback: "repo" },
				missingFallback: { title: "name" },
				junk: null,
			}),
		).toEqual({ "agent:a": { title: "QA", fallback: "repo" } });
	});
});

describe("pane title overrides", () => {
	beforeEach(() => usePaneTitleOverrides.setState({ overrides: {} }));

	it("survives automatic title updates and restores the latest automatic title", () => {
		const api = {
			id: "agent:a",
			title: "repo",
			setTitle: vi.fn<(title: string) => void>(),
		};

		renamePaneTitle(api, "Release QA");
		applyAutomaticPaneTitle(api, "new-cwd");
		expect(api.setTitle).toHaveBeenLastCalledWith("Release QA");
		expect(usePaneTitleOverrides.getState().overrides[api.id]).toEqual({
			title: "Release QA",
			fallback: "new-cwd",
		});

		renamePaneTitle(api, "");
		expect(api.setTitle).toHaveBeenLastCalledWith("new-cwd");
		expect(usePaneTitleOverrides.getState().overrides).toEqual({});
	});
});
