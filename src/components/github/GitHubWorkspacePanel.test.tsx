// @vitest-environment jsdom

import { chooseSelectValue } from "@/test/select";

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDockview } from "dockview-react";
import type { GitHubWorkItemRow } from "@/lib/github/githubResponses";
import { setLang } from "@/lib/i18n";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	state: {
		projects: [
			{
				id: "project-1",
				name: "Dure",
				path: "/work/dure",
				kind: "local" as const,
				isRepo: true,
			},
			{
				id: "project-2",
				name: "Docs",
				path: "/work/docs",
				kind: "local" as const,
				isRepo: true,
			},
		],
		agents: [],
		activeSpaceId: "space-1",
	},
	repository: vi.fn(),
	workItems: vi.fn(),
	projects: vi.fn(),
	issueDetails: vi.fn(),
	quickDispatch: vi.fn(),
	openAgent: vi.fn(),
	openExternal: vi.fn(),
	openIssue: vi.fn(),
}));

vi.mock(
	"@/components/github/useGitHubWorkspaceState",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/components/github/useGitHubWorkspaceState")
		>()),
		useGitHubWorkspaceState: () => mocks.state,
	}),
);
vi.mock("@/components/workspace/usePaneFirstReveal", () => ({
	usePaneFirstReveal: () => true,
}));
vi.mock("@/lib/ipc/github", () => ({
	ghRepository: mocks.repository,
	ghWorkspaceWorkItems: mocks.workItems,
	ghWorkspaceProjects: mocks.projects,
	ghIssueDetails: mocks.issueDetails,
}));
vi.mock("@/lib/agents/quickDispatch/quickDispatchActivation", () => ({
	requestQuickDispatch: mocks.quickDispatch,
}));
vi.mock("@/lib/platform/externalOpen", () => ({
	openExternalUrl: mocks.openExternal,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanelOnDesktop: mocks.openAgent,
}));
vi.mock("@/lib/workspace/dock/openGitHubIssuePanel", () => ({
	openGitHubIssuePanel: mocks.openIssue,
}));

import {
	GitHubIssuePanel,
	GitHubSidebarWorkspace,
	GitHubWorkspacePanel,
} from "./GitHubWorkspacePanel";

const repositoryFor = (projectId: string) => ({
	projectId,
	projectName: projectId === "project-1" ? "Dure" : "Docs",
	path: projectId === "project-1" ? "/work/dure" : "/work/docs",
	nameWithOwner: `hebbianai/${projectId === "project-1" ? "dure" : "docs"}`,
	owner: "hebbianai",
	url: `https://github.com/hebbianai/${projectId === "project-1" ? "dure" : "docs"}`,
	isInOrganization: true,
});

const panelProps = {
	params: { projectId: "project-1" },
	api: {},
	containerApi: {},
} as unknown as Parameters<typeof GitHubWorkspacePanel>[0];

const paginatedRows = (count: number): GitHubWorkItemRow[] =>
	Array.from({ length: count }, (_, index) => ({
		kind: "issue",
		number: index + 1,
		title: `Page item ${index + 1}`,
		url: `https://github.com/hebbianai/dure/issues/${index + 1}`,
		state: "OPEN",
		isDraft: false,
		assignees: [],
		reviewRequests: [],
		labels: [],
		updatedAt: "2026-09-03T01:00:00Z",
		checks: { total: 0, passed: 0, failed: 0, pending: 0 },
		repository: repositoryFor("project-1"),
	}));

beforeEach(() => {
	setLang("en");
	mocks.state.projects = [
		{
			id: "project-1",
			name: "Dure",
			path: "/work/dure",
			kind: "local",
			isRepo: true,
		},
		{
			id: "project-2",
			name: "Docs",
			path: "/work/docs",
			kind: "local",
			isRepo: true,
		},
	];
	mocks.repository.mockReset().mockImplementation(async (project) => ({
		ok: true,
		value: repositoryFor(project.id),
	}));
	mocks.workItems.mockReset().mockImplementation(async (repository, kind) => ({
		ok: true,
		value: [
			{
				kind,
				number: 42,
				title: kind === "pr" ? "Review workspace" : "Fix refresh",
				url: `${repository.url}/${kind === "pr" ? "pull" : "issues"}/42`,
				state: "OPEN",
				isDraft: false,
				author: "jwan",
				assignees: [],
				reviewRequests: [],
				labels: ["frontend"],
				updatedAt: "2026-09-03T01:00:00Z",
				checks: { total: 1, passed: 1, failed: 0, pending: 0 },
				repository,
			},
		],
	}));
	mocks.projects.mockReset().mockResolvedValue({ ok: true, value: [] });
	mocks.issueDetails.mockReset().mockImplementation(async (row) => ({
		ok: true,
		value: {
			...row,
			id: "I_issue42",
			body: "Inspect the **refresh lifecycle**.",
			createdAt: row.updatedAt,
			comments: [],
		},
	}));
	mocks.quickDispatch.mockReset();
	mocks.openAgent.mockReset();
	mocks.openExternal.mockReset();
	mocks.openIssue.mockReset();
});

it("discovers a registered project again when its registration-time Git observation was false", async () => {
	mocks.state.projects = [{ ...mocks.state.projects[0], isRepo: false }];
	render(<GitHubSidebarWorkspace projectId="project-1" />);
	await waitFor(() =>
		expect(mocks.repository).toHaveBeenCalledWith(mocks.state.projects[0]),
	);
	expect(await screen.findByText("Fix refresh")).toBeTruthy();
	expect(mocks.workItems).toHaveBeenCalledWith(
		repositoryFor("project-1"), "issue", "open", "",
	);
});

afterEach(() => {
	cleanup();
	setLang("ko");
});

describe("GitHubWorkspacePanel", () => {
	it.each(["pane-issue", "github-issue:project-1:1", "launcher:former"])(
		"projects open issue membership from current content at %s across restore and replacement",
		async (id) => {
			const rows = paginatedRows(2);
			mocks.workItems.mockResolvedValue({ ok: true, value: rows });
			const element = document.createElement("div");
			document.body.append(element);
			const dock = createDockview(element, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			dock.layout(1000, 700);
			registerDockview("another-space", dock);
			try {
				dock.addPanel({
					id,
					component: "githubissue",
					params: { row: rows[0] },
				});
				const saved = dock.toJSON();
				const publish = () =>
					useStore.setState((state) => ({
						layouts: { ...state.layouts, "another-space": dock.toJSON() },
					}));
				render(<GitHubSidebarWorkspace projectId="project-1" />);
				await screen.findByRole("button", { name: rows[0].title });
				const showing = (title: string) =>
					screen.getByRole("button", { name: title })
						.closest("[draggable]")!.classList.contains("bg-glass-tint-selected");
				expect(showing(rows[0].title)).toBe(true);
				expect(showing(rows[1].title)).toBe(false);
				act(() => {
					dock.replacePanel(dock.getPanel(id)!.api, {
						component: "terminal",
						params: { row: rows[0], sessionId: "retained" },
					});
					publish();
				});
				expect(showing(rows[0].title)).toBe(false);
				act(() => {
					dock.fromJSON(saved);
					publish();
				});
				expect(showing(rows[0].title)).toBe(true);
				act(() => {
					dock.getPanel(id)!.api.updateParameters({ row: rows[1] });
					publish();
				});
				expect(showing(rows[0].title)).toBe(false);
				expect(showing(rows[1].title)).toBe(true);
				act(() => {
					dock.getPanel(id)!.api.updateParameters({
						row: { ...rows[0], repository: repositoryFor("project-2") },
					});
					publish();
				});
				expect(showing(rows[0].title)).toBe(false);
				act(() => {
					dock.getPanel(id)!.api.updateParameters({ row: null });
					publish();
				});
				expect(showing(rows[0].title)).toBe(false);
				act(() => {
					dock.removePanel(dock.getPanel(id)!);
					publish();
				});
				expect(showing(rows[0].title)).toBe(false);
				expect(showing(rows[1].title)).toBe(false);
				expect(mocks.issueDetails).not.toHaveBeenCalled();
				expect(mocks.workItems).toHaveBeenCalledTimes(1);
			} finally {
				unregisterDockview("another-space", dock);
				dock.dispose();
				element.remove();
			}
		},
	);
	it("opens a separate pane only from the issue context menu, leaving the sidebar list in place", async () => {
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		const title = await screen.findByRole("button", { name: "Fix refresh" });
		fireEvent.contextMenu(title);
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "Open in new pane" }),
		);
		expect(mocks.openIssue).toHaveBeenCalledWith(
			"space-1",
			expect.objectContaining({ kind: "issue", number: 42 }),
		);
		expect(mocks.issueDetails).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Fix refresh" })).toBeTruthy();
	});
	it("does not refetch or reclaim focus when an issue pane publishes its loaded summary", async () => {
		const row = paginatedRows(1)[0];
		let resolveRead: (value: unknown) => void = () => {};
		mocks.issueDetails.mockReset().mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRead = resolve;
				}),
		);
		const updateParameters = vi.fn();
		render(
			<>
				<input aria-label="Other pane input" />
				<GitHubIssuePanel
					{...({
						params: { row },
						api: { updateParameters },
					} as unknown as Parameters<typeof GitHubIssuePanel>[0])}
				/>
			</>,
		);
		const input = screen.getByRole("textbox", { name: "Other pane input" });
		input.focus();
		await act(async () =>
			resolveRead({
				ok: true,
				value: {
					...row,
					id: "I_test",
					body: "Loaded issue body",
					comments: [],
				},
			}),
		);
		expect(screen.getByText("Loaded issue body")).toBeTruthy();
		expect(mocks.issueDetails).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(input);
		expect(updateParameters).toHaveBeenCalledTimes(1);
	});

	it("drags the sidebar issue through the shared product payload without opening details", async () => {
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		const title = await screen.findByRole("button", { name: "Fix refresh" });
		const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
		fireEvent.dragStart(title, { dataTransfer });
		expect(dataTransfer.setData).toHaveBeenCalledWith(
			"text/plain",
			expect.stringContaining('"type":"github-issue"'),
		);
		expect(mocks.issueDetails).not.toHaveBeenCalled();
	});
	it.each(["pane", "sidebar"] as const)(
		"stops queued repository reads after %s unmount",
		async (mode) => {
			mocks.state.projects = Array.from({ length: 5 }, (_, index) => ({
				id: `project-${index + 1}`,
				name: `Repo ${index + 1}`,
				path: `/repo/${index + 1}`,
				kind: "local",
				isRepo: true,
			}));
			const finish: (() => void)[] = [];
			mocks.repository.mockImplementation(
				(project) =>
					new Promise((resolve) => {
						finish.push(() =>
							resolve({ ok: true, value: repositoryFor(project.id) }),
						);
					}),
			);
			const mounted = render(
				mode === "pane" ? (
					<GitHubWorkspacePanel {...panelProps} params={{}} />
				) : (
					<GitHubSidebarWorkspace />
				),
			);
			expect(mocks.repository).toHaveBeenCalledTimes(4);
			mounted.unmount();
			await act(async () => {
				for (const resolve of finish.slice()) resolve();
			});
			expect(mocks.repository).toHaveBeenCalledTimes(4);
			expect(mocks.workItems).not.toHaveBeenCalled();
		},
	);

	it("stops obsolete queued reads when the repository target changes", async () => {
		mocks.state.projects = Array.from({ length: 5 }, (_, index) => ({
			id: `project-${index + 1}`,
			name: `Repo ${index + 1}`,
			path: `/repo/${index + 1}`,
			kind: "local",
			isRepo: true,
		}));
		const finish: (() => void)[] = [];
		for (let index = 0; index < 4; index += 1) {
			mocks.repository.mockImplementationOnce(
				(project) =>
					new Promise((resolve) => {
						finish.push(() =>
							resolve({ ok: true, value: repositoryFor(project.id) }),
						);
					}),
			);
		}
		render(<GitHubSidebarWorkspace />);
		expect(mocks.repository).toHaveBeenCalledTimes(4);
		chooseSelectValue(screen.getByRole("combobox", { name: "Repository" }), "project-1");
		await screen.findByText("Fix refresh");
		await act(async () => {
			for (const resolve of finish) resolve();
		});
		expect(mocks.repository).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: "project-5" }),
		);
		expect(mocks.workItems).toHaveBeenCalledTimes(1);
		expect(screen.getByText("Fix refresh")).toBeTruthy();
	});
	it("keeps the latest view when an older work-item response arrives last", async () => {
		let finish: (() => void) | undefined;
		mocks.workItems.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = () =>
						resolve({ ok: true, value: paginatedRows(1), limitReached: false });
				}),
		);
		render(<GitHubWorkspacePanel {...panelProps} />);
		await waitFor(() => expect(mocks.workItems).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
		await screen.findByText("Review workspace");
		await act(async () => finish?.());
		expect(screen.getByText("Review workspace")).toBeTruthy();
		expect(screen.queryByText("Page item 1")).toBeNull();
		expect(
			(screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
				.disabled,
		).toBe(false);
	});

	it("reconciles a changed detail through the authoritative filtered list", async () => {
		const closed = { ...paginatedRows(1)[0], state: "CLOSED" };
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: [closed],
			limitReached: false,
		});
		// The in-place detail lives in the pane now; the sidebar opens a pane instead.
		render(<GitHubWorkspacePanel {...panelProps} />);
		await screen.findByText("Page item 1");
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search GitHub work" }),
			{ target: { value: "is:closed" } },
		);
		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.anything(),
				"issue",
				"all",
				"is:closed",
			),
		);
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: [],
			limitReached: false,
		});
		mocks.issueDetails.mockResolvedValue({
			ok: true,
			value: {
				...closed,
				state: "OPEN",
				id: "I_issue1",
				body: "Reopened on GitHub",
				createdAt: closed.updatedAt,
				comments: [],
			},
		});
		fireEvent.click(await screen.findByText("Page item 1"));
		await screen.findByText("Reopened on GitHub");
		fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
		expect(await screen.findByText("Nothing here yet")).toBeTruthy();
	});
	it("resets pagination when the dropdown changes status and keeps the native query compatible", async () => {
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: paginatedRows(76),
			limitReached: false,
		});
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		await screen.findByText("Page item 1");
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(screen.getByText("Page item 26")).toBeTruthy();
		fireEvent.keyDown(screen.getByRole("button", { name: "Filters" }), {
			key: "ArrowDown",
		});
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Status/ }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Closed" }));
		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.anything(),
				"issue",
				"all",
				"is:closed",
			),
		);
		expect(await screen.findByText("Page item 1")).toBeTruthy();
		expect(screen.queryByText("Page item 26")).toBeNull();
	});
	it("retains the page on refresh, clamps a shrinking result, and resets on search", async () => {
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: paginatedRows(76),
			limitReached: false,
		});
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		await screen.findByText("Page item 1");
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Page item 51")).toBeTruthy();
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: paginatedRows(30),
			limitReached: false,
		});
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Page item 26")).toBeTruthy();
		expect(screen.getByText("2 / 2")).toBeTruthy();
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: paginatedRows(76),
			limitReached: false,
		});
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("Page item 26")).toBeTruthy();
		expect(screen.getByText("2 / 4")).toBeTruthy();
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search GitHub work" }),
			{ target: { value: "retry" } },
		);
		expect(
			(
				screen.getByRole("button", {
					name: "Previous page",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.anything(),
				"issue",
				"open",
				"retry",
			),
		);
		expect(await screen.findByText("Page item 1")).toBeTruthy();
		expect(screen.getByText("1 / 4")).toBeTruthy();
	});
	it("keeps pane and sidebar filter and page selection independent", async () => {
		mocks.workItems.mockResolvedValue({
			ok: true,
			value: paginatedRows(76),
			limitReached: false,
		});
		const pane = within(
			render(<GitHubWorkspacePanel {...panelProps} />).container,
		);
		const sidebar = within(
			render(<GitHubSidebarWorkspace projectId="project-1" />).container,
		);
		await pane.findByText("Page item 1");
		await sidebar.findByText("Page item 1");
		fireEvent.click(sidebar.getByRole("button", { name: "Next page" }));
		fireEvent.change(
			pane.getByRole("searchbox", { name: "Search GitHub work" }),
			{ target: { value: "is:closed" } },
		);
		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.anything(),
				"issue",
				"all",
				"is:closed",
			),
		);
		expect(
			(
				sidebar.getByRole("searchbox", {
					name: "Search GitHub work",
				}) as HTMLInputElement
			).value,
		).toBe("");
		expect(sidebar.getByText("Page item 26")).toBeTruthy();
		expect(pane.getByText("Page item 1")).toBeTruthy();
	});
	it.each(["sidebar", "pane"])(
		"paginates the %s beyond the old 50-row cutoff and preserves the page after details",
		async (mode) => {
			mocks.workItems.mockImplementation(async (repository, kind) => ({
				ok: true,
				value: Array.from({ length: 76 }, (_, index) => ({
					kind,
					number: index + 1,
					title: `Paginated issue ${index + 1}`,
					url: `${repository.url}/issues/${index + 1}`,
					state: "OPEN",
					isDraft: false,
					assignees: [],
					reviewRequests: [],
					labels: [],
					updatedAt: "2026-09-03T01:00:00Z",
					checks: { total: 0, passed: 0, failed: 0, pending: 0 },
					repository,
				})),
			}));
			const { container } = render(
				mode === "sidebar" ? (
					<GitHubSidebarWorkspace projectId="project-1" />
				) : (
					<GitHubWorkspacePanel {...panelProps} />
				),
			);
			await screen.findByRole("button", {
				name: /^Paginated issue 1(?:[^0-9]|$)/,
			});
			expect(
				screen.queryByRole("button", {
					name: /^Paginated issue 26(?:[^0-9]|$)/,
				}),
			).toBeNull();
			const viewport = container.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']")!;
			viewport.scrollTop = 200;
			fireEvent.click(screen.getByRole("button", { name: "Next page" }));
			expect(viewport.scrollTop).toBe(0);
			fireEvent.click(screen.getByRole("button", { name: "Next page" }));
			const issue = screen.getByRole("button", {
				name: /^Paginated issue 51(?:[^0-9]|$)/,
			});
			expect(mocks.workItems).toHaveBeenCalledTimes(1);
			fireEvent.click(issue);
			await screen.findByRole("region", { name: "Issue details" });
			fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
			expect(
				await screen.findByRole("button", {
					name: /^Paginated issue 51(?:[^0-9]|$)/,
				}),
			).toBeTruthy();
			expect(mocks.workItems).toHaveBeenCalledTimes(2);
			fireEvent.click(screen.getByRole("button", { name: "Next page" }));
			expect(
				screen.getByRole("button", { name: /^Paginated issue 76(?:[^0-9]|$)/ }),
			).toBeTruthy();
			expect(
				(screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
					.disabled,
			).toBe(true);
		},
	);
	it.each(["sidebar", "pane"])(
		"opens issue details in the %s and returns to the same search",
		async (mode) => {
			render(
				mode === "sidebar" ? (
					<GitHubSidebarWorkspace projectId="project-1" />
				) : (
					<GitHubWorkspacePanel {...panelProps} />
				),
			);
			fireEvent.change(
				screen.getByRole("searchbox", { name: "Search GitHub work" }),
				{ target: { value: "refresh" } },
			);
			await waitFor(() =>
				expect(mocks.workItems).toHaveBeenLastCalledWith(
					expect.anything(),
					"issue",
					"open",
					"refresh",
				),
			);
			fireEvent.click(
				await screen.findByRole("button", { name: /^Fix refresh/ }),
			);
			expect(mocks.openExternal).not.toHaveBeenCalled();
			expect(await screen.findByText("refresh lifecycle")).toBeTruthy();
			fireEvent.click(screen.getByRole("button", { name: /Start/ }));
			expect(mocks.quickDispatch).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: "project-1" }),
			);
			fireEvent.click(screen.getByRole("button", { name: "Back to list" }));
			expect(
				(
					screen.getByRole("searchbox", {
						name: "Search GitHub work",
					}) as HTMLInputElement
				).value,
			).toBe("refresh");
			fireEvent.click(screen.getByRole("button", { name: /#42/ }));
			expect(await screen.findByText("refresh lifecycle")).toBeTruthy();
			expect(mocks.openExternal).not.toHaveBeenCalled();
		},
	);

	it("packs sidebar navigation into two toolbars and each result into two lines", async () => {
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		const result = await screen.findByRole("listitem");
		const toolbars = screen.getAllByRole("toolbar");

		expect(toolbars).toHaveLength(2);
		expect(
			within(toolbars[0]).getByRole("combobox", { name: "Repository" }),
		).toBeTruthy();
		expect(
			within(toolbars[0]).getByRole("radio", { name: "Issues" }),
		).toBeTruthy();
		expect(
			within(toolbars[1]).getByRole("searchbox", {
				name: "Search GitHub work",
			}),
		).toBeTruthy();
		expect(
			within(toolbars[1]).getByRole("button", { name: "Filters" }),
		).toBeTruthy();
		// The row keeps 2px of its height outside the hover surface; the two
		// lines live on that inner surface.
		expect(result.firstElementChild?.children).toHaveLength(2);
	});

	it("keeps closed issue and merged PR states truthful in the compact list", async () => {
		mocks.workItems.mockImplementation(async (repository, kind) => ({
			ok: true,
			value: [
				{
					kind,
					number: 42,
					title: kind === "pr" ? "Merged workspace" : "Closed refresh",
					url: `${repository.url}/${kind === "pr" ? "pull" : "issues"}/42`,
					state: kind === "pr" ? "MERGED" : "CLOSED",
					isDraft: false,
					assignees: [],
					reviewRequests: [],
					labels: [],
					updatedAt: "2026-09-03T01:00:00Z",
					checks: { total: 0, passed: 0, failed: 0, pending: 0 },
					repository,
				},
			],
		}));
		render(<GitHubSidebarWorkspace projectId="project-1" />);

		expect(await screen.findByRole("img", { name: "Closed" })).toBeTruthy();
		fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
		expect(await screen.findByRole("img", { name: "Merged" })).toBeTruthy();
	});

	it("keeps repository, PR, search, and Start controls in the sidebar", async () => {
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		expect(await screen.findByText("Fix refresh")).toBeTruthy();
		expect(screen.getByRole("combobox", { name: "Repository" })).toBeTruthy();

		fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
		expect(await screen.findByText("Review workspace")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Review workspace" }));
		expect(mocks.openExternal).toHaveBeenCalledWith(
			"https://github.com/hebbianai/dure/pull/42",
		);
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search GitHub work" }),
			{ target: { value: "handoff" } },
		);
		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.objectContaining({ projectId: "project-1" }),
				"pr",
				"open",
				"handoff",
			),
		);

		fireEvent.click(screen.getByRole("button", { name: /Start/ }));
		expect(mocks.quickDispatch).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-1" }),
		);
	});

	it("switches between issues and PRs, and starts a prefilled agent", async () => {
		render(<GitHubWorkspacePanel {...panelProps} />);
		expect(await screen.findByText("Fix refresh")).toBeTruthy();

		fireEvent.click(screen.getByRole("radio", { name: "Pull requests" }));
		expect(await screen.findByText("Review workspace")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /Start/ }));

		expect(mocks.workItems).toHaveBeenLastCalledWith(
			expect.objectContaining({ projectId: "project-1" }),
			"pr",
			"open",
			"",
		);
		expect(mocks.quickDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				typedName: "github-pr-42-review-workspace",
			}),
		);
	});

	it("changes the repository that owns subsequent queries", async () => {
		render(<GitHubWorkspacePanel {...panelProps} />);
		await screen.findByText("Fix refresh");
		chooseSelectValue(screen.getByRole("combobox", { name: "Repository" }), "project-2");

		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.objectContaining({ projectId: "project-2" }),
				"issue",
				"open",
				"",
			),
		);
	});

	it("starts unscoped multi-repository surfaces on All repositories", async () => {
		render(<GitHubWorkspacePanel {...panelProps} params={{}} />);

		await waitFor(() => expect(mocks.repository).toHaveBeenCalledTimes(2));
		expect(
			screen.getByRole("combobox", {
					name: "Repository",
				}).textContent,
		).toBe("All repositories");
	});

	it("debounces search into the selected GitHub list command", async () => {
		render(<GitHubWorkspacePanel {...panelProps} />);
		await screen.findByText("Fix refresh");
		fireEvent.change(
			screen.getByRole("searchbox", { name: "Search GitHub work" }),
			{
				target: { value: "flicker" },
			},
		);

		await waitFor(() =>
			expect(mocks.workItems).toHaveBeenLastCalledWith(
				expect.objectContaining({ projectId: "project-1" }),
				"issue",
				"open",
				"flicker",
			),
		);
	});

	it("shows a Projects-only scope remedy", async () => {
		mocks.projects.mockResolvedValue({
			ok: false,
			error: { kind: "project-scope", detail: "read:project" },
		});
		render(<GitHubWorkspacePanel {...panelProps} />);
		await screen.findByText("Fix refresh");
		fireEvent.click(screen.getByRole("radio", { name: "Projects" }));

		expect(await screen.findByText(/read:project/)).toBeTruthy();
		expect(screen.getByText("Nothing here yet")).toBeTruthy();
	});

	it("keeps the cap notice when a bounded Projects snapshot has no local matches", async () => {
		mocks.projects.mockResolvedValue({
			ok: true,
			value: [],
			limitReached: true,
		});
		render(<GitHubSidebarWorkspace projectId="project-1" />);
		await screen.findByText("Fix refresh");
		fireEvent.click(screen.getByRole("radio", { name: "Projects" }));
		expect(
			await screen.findByText(/Up to 1,000 results per source/),
		).toBeTruthy();
		expect(screen.getByText("Nothing here yet")).toBeTruthy();
	});

	it("opens Projects on the selected repository's host and owner kind", async () => {
		mocks.repository.mockResolvedValue({
			ok: true,
			value: {
				...repositoryFor("project-1"),
				owner: "octocat",
				url: "https://github.example.test/octocat/dure",
				isInOrganization: false,
			},
		});
		render(<GitHubWorkspacePanel {...panelProps} />);
		await screen.findByText("Fix refresh");
		fireEvent.click(screen.getByRole("radio", { name: "Projects" }));
		await screen.findByText("Nothing here yet");
		fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));

		expect(mocks.openExternal).toHaveBeenCalledWith(
			"https://github.example.test/users/octocat/projects",
		);
	});

	it("selects the sole repository when projects hydrate after mount", async () => {
		mocks.state.projects = [];
		const unscopedProps = { ...panelProps, params: {} };
		const { rerender } = render(<GitHubWorkspacePanel {...unscopedProps} />);
		expect(await screen.findByText("No local repositories")).toBeTruthy();

		mocks.state.projects = [
			{
				id: "project-1",
				name: "Dure",
				path: "/work/dure",
				kind: "local",
				isRepo: true,
			},
		];
		rerender(<GitHubWorkspacePanel {...unscopedProps} />);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", {
						name: "Repository",
					}).textContent,
			).toBe("Dure"),
		);
		await screen.findByText("Fix refresh");
		fireEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));
		expect(mocks.openExternal).toHaveBeenCalledWith(
			"https://github.com/hebbianai/dure/issues",
		);
	});
});
