// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRow } from "@/components/agents/AgentRow";
import { activityLabel } from "@/components/agents/StatusBits";
import { agentRowModel } from "@/lib/agents/agentRowModel";
import { t } from "@/lib/i18n";

afterEach(cleanup);

const row = agentRowModel({
	agentId: "worker",
	title: "Fix the build",
	state: "blocked",
	needsPerson: { reason: "approval" },
	projectName: "repo",
	spaceName: "Review",
	path: ["coordinator", "lead"],
	managed: { count: 4, needsPerson: 1, working: 2 },
	approval: { toolName: "Bash" },
});

describe("AgentRow", () => {
	it("reads the same in every variant: status, place, path, team and activity", () => {
		for (const variant of ["list", "card"] as const) {
			render(<AgentRow row={row} variant={variant} />);
			const button = screen.getByRole("button");
			expect(button.getAttribute("data-variant")).toBe(variant);
			expect(button.textContent).toContain("coordinator › lead");
			expect(button.textContent).toContain("Fix the build");
			expect(button.textContent).toContain(
				[activityLabel("blocked"), "repo", "Review"].join(" · "),
			);
			expect(button.textContent).toContain(
				[
					t("agents.row.manages", { n: 4 }),
					t("agents.row.managedNeedYou", { n: 1 }),
					t("agents.row.managedWorking", { n: 2 }),
				].join(" · "),
			);
			expect(button.textContent).toContain(t("agents.row.approval", { tool: "Bash" }));
			cleanup();
		}
	});

	it("fits on one line inside another agent's conversation", () => {
		render(<AgentRow row={row} variant="line" />);
		const button = screen.getByRole("button");
		expect(button.getAttribute("data-variant")).toBe("line");
		expect(button.textContent).toContain("coordinator › lead ›");
		expect(button.textContent).toContain("Fix the build");
		expect(button.textContent).toContain(
			[
				activityLabel("blocked"),
				"repo",
				"Review",
				t("agents.row.manages", { n: 4 }),
				t("agents.row.managedNeedYou", { n: 1 }),
				t("agents.row.managedWorking", { n: 2 }),
			].join(" · "),
		);
		expect(button.textContent).not.toContain(t("agents.row.approval", { tool: "Bash" }));
	});

	it("adds nothing for facts it lacks", () => {
		render(<AgentRow row={agentRowModel({ agentId: "a", title: "Plain" })} />);
		expect(screen.getByRole("button").textContent).toBe("Plain");
	});

	it("names an exit by its cause", () => {
		render(
			<AgentRow
				row={agentRowModel({
					agentId: "a",
					title: "Signed out",
					state: "exited",
					needsPerson: { reason: "unexpected_exit", signIn: true },
				})}
			/>,
		);
		expect(screen.getByRole("button").textContent).toContain(
			t("agents.row.signInExit"),
		);
	});

	it("leaves selecting to the caller", () => {
		const onSelect = vi.fn();
		render(<AgentRow row={row} onSelect={onSelect} />);
		fireEvent.click(screen.getByRole("button"));
		expect(onSelect).toHaveBeenCalledWith("worker");
	});
});
