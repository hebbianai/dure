// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDiffBadge } from "@/components/agents/AgentDiffBadge";
import { useDiffBadges } from "@/lib/scm/status/diffBadgesStore";

beforeEach(() => {
	useDiffBadges.setState({
		badges: {
			"agent-1": {
				added: 8,
				deleted: 3,
				binary: 0,
				files: 3,
				committed: { added: 0, deleted: 0, binary: 0, files: 0 },
				worktree: { added: 8, deleted: 3, binary: 0, files: 91 },
				ahead: 0,
				behind: 59,
			},
		},
	});
});

afterEach(() => {
	cleanup();
	useDiffBadges.setState({ badges: {} });
});

describe("AgentDiffBadge", () => {
	it("launches the diff window from the counters when a launcher is given", () => {
		const onClick = vi.fn();
		render(<AgentDiffBadge agentId="agent-1" onClick={onClick} />);
		const badge = screen.getByRole("button");
		expect(badge.textContent).toBe("W91↓59");
		fireEvent.click(badge);
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("renders the same counters as a plain indicator without a launcher", () => {
		render(<AgentDiffBadge agentId="agent-1" />);
		expect(screen.queryByRole("button")).toBeNull();
		const badge = screen.getByRole("img");
		expect(badge.textContent).toBe("W91↓59");
	});

	it("renders nothing without a badge", () => {
		const { container } = render(
			<AgentDiffBadge agentId="agent-2" onClick={vi.fn()} />,
		);
		expect(container.innerHTML).toBe("");
	});
});
