// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));
vi.mock("@/lib/agents/agentInstalls", () => ({
	useAvailableProviders: () => ["claude"],
	useQuickStartProviders: () => ({ available: ["claude"], quick: ["claude"] }),
}));
const removal = vi.hoisted(() => ({
	plan: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("@/lib/agents/resourceLifecycle", () => ({
	planProjectRemoval: removal.plan,
	executeProjectRemoval: removal.execute,
}));

import { SpacesRepositoryHeader } from "@/components/spaces/SpacesRepositoryHeader";
import { useStore } from "@/store";
import type { Project } from "@/types";

const PROJECT = { id: "p1", name: "Dure", path: "/repo" } as Project;

function renderHeader(projectId: string | undefined) {
	render(
		<SpacesRepositoryHeader
			group={{ key: "p1", label: "Dure", projectId, spaces: [] }}
			headingId="repo-heading"
			level="group"
			collapsed={false}
			onToggleCollapsed={vi.fn()}
			projects={[PROJECT]}
			sshHosts={[]}
			onAddRepositoryTerminal={vi.fn()}
			onAddRepositoryAgent={vi.fn(async () => {})}
			onAddRepositoryAgentWithOptions={vi.fn()}
		/>,
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useStore.setState({ pinnedProjects: [] });
});

describe("SpacesRepositoryHeader quick-add rail", () => {
	it("still dispatches the rail's terminal click through the context-menu wrapper", () => {
		const onAddRepositoryTerminal = vi.fn();
		const onToggleCollapsed = vi.fn();
		render(
			<SpacesRepositoryHeader
				group={{ key: "p1", label: "Dure", projectId: "p1", spaces: [] }}
				headingId="repo-heading"
				level="group"
				collapsed={false}
				onToggleCollapsed={onToggleCollapsed}
				desktopId="d1"
				projects={[PROJECT]}
				sshHosts={[]}
				onAddRepositoryTerminal={onAddRepositoryTerminal}
				onAddRepositoryAgent={vi.fn(async () => {})}
				onAddRepositoryAgentWithOptions={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "터미널 열기" }));
		expect(onAddRepositoryTerminal).toHaveBeenCalledWith(
			"d1",
			expect.objectContaining({ projectId: "p1", path: "/repo" }),
		);
		expect(onToggleCollapsed).not.toHaveBeenCalled();
	});
});

describe("SpacesRepositoryHeader disclosure", () => {
	it.each(["group", "sub"] as const)("folds from the chevron and count at %s level", (level) => {
		function Repository() {
			const [collapsed, setCollapsed] = useState(false);
			return (
				<section aria-labelledby="repo-heading">
					<SpacesRepositoryHeader
						group={{ key: "p1", label: "Dure", projectId: "p1", spaces: [] }}
						headingId="repo-heading"
						level={level}
						collapsed={collapsed}
						onToggleCollapsed={() => setCollapsed((value) => !value)}
						attentionCount={1}
						projects={[PROJECT]}
						sshHosts={[]}
						quickAdd={false}
					/>
				</section>
			);
		}
		const { container } = render(<Repository />);
		const toggle = screen.getByRole("button", { name: "Dure" });
		// Click the decorative path itself, just as the pointer hits the glyph.
		fireEvent.click(container.querySelector(".lucide-chevron-right path")!);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.getByRole("heading", { name: "Dure" })).toBeTruthy();
		expect(screen.getByRole("region", { name: "Dure" })).toBeTruthy();
		fireEvent.click(screen.getByText("Dure"));
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(screen.getByText("Dure"));
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("SpacesRepositoryHeader project menu", () => {
	it("removes a registered project from the list after confirming in the row", async () => {
		const plan = {
			projectId: "p1",
			project: PROJECT,
			sshHostScope: [],
			agents: [{ id: "a1" }, { id: "a2" }],
		};
		removal.plan.mockReturnValue(plan);
		removal.execute.mockResolvedValue(plan);
		renderHeader("p1");

		fireEvent.contextMenu(screen.getByText("Dure"));
		const remove = await screen.findByRole("menuitem", { name: /프로젝트 제거/ });
		fireEvent.click(remove);

		// The question opens as a dialog — the effect spans surfaces (SOUL §6) —
		// with the consequence in its description, so the agents warning is not
		// lost. Nothing is removed until the dialog's confirm.
		const confirm = await screen.findByRole("dialog");
		expect(confirm.textContent).toContain("'Dure' 프로젝트를 목록에서 제거할까요?");
		expect(confirm.textContent).toContain("연결된 에이전트 2개");
		expect(confirm.textContent).toContain("디스크에서 삭제하지 않습니다");
		expect(removal.plan).toHaveBeenCalledWith("p1");
		expect(removal.execute).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "프로젝트 제거" }));
		await waitFor(() => expect(removal.execute).toHaveBeenCalledWith(plan));
	});

	it("cancel puts the head row back without removing anything", async () => {
		removal.plan.mockReturnValue({
			projectId: "p1",
			project: PROJECT,
			sshHostScope: [],
			agents: [],
		});
		renderHeader("p1");
		fireEvent.contextMenu(screen.getByText("Dure"));
		fireEvent.click(await screen.findByRole("menuitem", { name: /프로젝트 제거/ }));
		await screen.findByRole("dialog");

		fireEvent.click(screen.getByRole("button", { name: "취소" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText("Dure")).toBeTruthy();
		expect(removal.execute).not.toHaveBeenCalled();
	});

	it("pins and unpins the project from the same menu", async () => {
		renderHeader("p1");
		fireEvent.contextMenu(screen.getByText("Dure"));
		fireEvent.click(await screen.findByRole("menuitem", { name: /상단 고정/ }));
		await waitFor(() =>
			expect(useStore.getState().pinnedProjects).toContain("p1"),
		);
		fireEvent.contextMenu(screen.getByText("Dure"));
		expect(await screen.findByRole("menuitem", { name: /핀 해제/ })).toBeTruthy();
	});

	it("a registered project in the unopened queue (quickAdd off) has no menu", () => {
		render(
			<SpacesRepositoryHeader
				group={{ key: "p1", label: "Dure", projectId: "p1", spaces: [] }}
				headingId="repo-heading"
				level="group"
				collapsed={false}
				onToggleCollapsed={vi.fn()}
				projects={[PROJECT]}
				sshHosts={[]}
				quickAdd={false}
			/>,
		);
		fireEvent.contextMenu(screen.getByText("Dure"));
		expect(screen.queryByRole("menu")).toBeNull();
		expect(removal.plan).not.toHaveBeenCalled();
	});

	it("a location group with no registered project has no menu", () => {
		renderHeader(undefined);
		fireEvent.contextMenu(screen.getByText("Dure"));
		expect(screen.queryByRole("menu")).toBeNull();
		expect(removal.plan).not.toHaveBeenCalled();
	});
});
