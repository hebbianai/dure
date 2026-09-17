// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExistingWorktreeSelector } from "@/components/agents/addAgent/ExistingWorktreeSelector";
import { setLang } from "@/lib/i18n";
import type { ExistingWorktreeCandidate } from "@/lib/ipc";

const candidate: ExistingWorktreeCandidate = {
	reference: {
		canonicalPath: "/repo/.worktrees/dure-frontend",
		gitCommonDir: "/repo/.git",
		gitDir: "/repo/.git/worktrees/dure-frontend",
		branch: "agent/dure-frontend",
		head: "0123456789abcdef0123456789abcdef01234567",
	},
	isMain: false,
	ownership: {
		state: "ambiguous",
		owners: [
			{
				agentId: "agent-one",
				provider: "codex",
				channel: "dev-one",
				runtimeLiveness: "live",
				paneLiveness: "live",
			},
			{
				agentId: "agent-two",
				provider: "claude",
				channel: "dev-two",
				runtimeLiveness: "live",
				paneLiveness: "live",
			},
		],
	},
};

afterEach(() => {
	cleanup();
	setLang("ko");
});

describe("ExistingWorktreeSelector", () => {
	it("renders ownership guidance in the selected English language", () => {
		setLang("en");
		render(
			<ExistingWorktreeSelector
				source="existing"
				onSourceChange={vi.fn()}
				candidates={[candidate]}
				selectedPath={candidate.reference.canonicalPath}
				onSelectedPathChange={vi.fn()}
				loading={false}
				error={null}
				limit={128}
				truncated={false}
				recoveringPath={null}
				inspectingPath={null}
				onRecover={vi.fn()}
				onInspect={vi.fn()}
				onRetry={vi.fn()}
			/>,
		);

		expect(
			screen.getByText(
				(_content, element) =>
					element?.tagName === "P" &&
					Boolean(
						element.textContent?.includes(
							"Ownership needs review",
						),
					),
			),
		).toBeTruthy();
		expect(screen.queryByText(/중복 registry owner/)).toBeNull();
	});
});
