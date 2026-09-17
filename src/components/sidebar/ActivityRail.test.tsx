// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityRail } from "@/components/sidebar/ActivityRail";
import type { DurePluginViewContainer } from "@/lib/plugins/durePlugins";
import type { DurePluginPermissionSnapshot } from "@/lib/ipc/plugins";
import { pluginSidebarContainerKey } from "@/lib/plugins/pluginSidebarSelection";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";
import {
	dismissUpdateNotice,
	resetUpdateNotices,
	updateNoticeSnapshot,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";

const permissionMocks = vi.hoisted(() => ({
	permission: null as DurePluginPermissionSnapshot | null,
	usePermission: vi.fn(),
}));

vi.mock("@/components/plugins/usePluginPermissionWorkspace", () => ({
	usePluginPermissionWorkspace: permissionMocks.usePermission,
}));

function setPermission(enabled: boolean) {
	permissionMocks.permission = {
		enabled,
		plan_comparison: "matches_reviewed_plan",
	} as DurePluginPermissionSnapshot;
}

const beadsContainer = {
	plugin: { manifest: { id: "dure.beads" } },
	contributionId: "dure.beads.views",
	container: {
		id: "dure.beads.issues",
		location: "primary_sidebar",
		title: { default: "Beads" },
		icon: "list_todo",
	},
	views: [{ id: "dure.beads.issues.list" }],
} as DurePluginViewContainer;

describe("ActivityRail", () => {
	it("opens Automations from the collapsed rail in Pro", () => {
		useWindowSidebarStore.setState({ open: false, tab: "spaces" });
		render(<ActivityRail onOpenSettings={vi.fn()} />);
		act(() => screen.getByRole("button", { name: t("automations.title") }).click());
		expect(useWindowSidebarStore.getState().tab).toBe("automations");
		expect(useWindowSidebarStore.getState().open).toBe(true);
	});

	beforeEach(() => {
		setPermission(true);
		permissionMocks.usePermission.mockImplementation((input) => ({
			permission: input ? permissionMocks.permission : null,
			permissionLoaded: true,
			permissionError: null,
		}));
		// The rail's full surface set is the pro experience (migrated installs);
		// basic-mode folding has its own cases below.
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
			focusCtx: { cwd: "/work/repo", source: "local", label: "repo" },
		}));
	});
	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
		useWindowSidebarStore.setState({ open: true, tab: "spaces" });
		resetUpdateNotices();
		permissionMocks.usePermission.mockReset();
		useStore.setState({ focusCtx: null });
	});

	// 접었다 펴는 동안 선택된 아이콘이 바뀌면 안 된다 — 배경도, 글자색도.
	// 예전에는 접힘 전용 표면(--background)으로 내려가서 접을 때마다 아이콘
	// 칩만 어두워졌다. 클래스 문자열을 통째로 비교하므로 색·배경·테두리 중
	// 무엇이 갈라지든 잡힌다.
	it("접어도 선택된 아이콘의 표면과 글자색이 그대로다", () => {
		const activeTab = useWindowSidebarStore.getState().tab;
		const label = { spaces: "스페이스", recovery: "세션", files: "파일" }[
			activeTab as string
		];
		if (!label) return; // 기본 탭이 바뀌면 이 단언은 의미가 없다

		useWindowSidebarStore.setState({ open: true });
		render(<ActivityRail onOpenSettings={vi.fn()} />);
		const opened = screen.getByRole("button", { name: label }).className;
		cleanup();

		useWindowSidebarStore.setState({ open: false });
		render(<ActivityRail onOpenSettings={vi.fn()} />);
		const collapsed = screen.getByRole("button", { name: label }).className;

		expect(collapsed).toBe(opened);
		expect(collapsed).toContain("text-sidebar-foreground");
	});

	it("badges the Spaces item with the count of sessions needing a human", () => {
		useAgentAttention.setState({
			displayStates: { a1: "blocked", a2: "input", a3: "working" },
		});
		try {
			render(<ActivityRail onOpenSettings={vi.fn()} />);
			const spacesItem = screen.getByRole("button", {
				name: /스페이스 · 주의 필요 2개/,
			});
			expect(spacesItem.textContent).toContain("2");
		} finally {
			useAgentAttention.setState({ displayStates: {} });
		}
	});

	it("keeps the Spaces item silent when no session needs a human", () => {
		render(<ActivityRail onOpenSettings={vi.fn()} />);
		const spacesItem = screen.getByRole("button", { name: "스페이스" });
		expect(spacesItem.textContent).toBe("");
	});

	it("does not expose retired search or decision inbox rail items", () => {
		render(
			<ActivityRail onOpenSettings={vi.fn()} />,
		);

		expect(screen.queryByRole("button", { name: "검색" })).toBeNull();
		expect(screen.getByRole("button", { name: "스페이스" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "결정함" })).toBeNull();
	});

	it("keeps unresolved updates badged after their card is dismissed", () => {
		act(() => {
			upsertUpdateNotice({
				sourceRef: "source.fixture",
				revision: "v1",
				title: "Update available",
				description: "Dure v1 is ready.",
				impact: "No session interruption",
				primaryAction: {
					label: "Update",
					progressLabel: "Updating…",
					completion: "resolve",
					run: vi.fn(),
				},
			});
		});
		render(<ActivityRail onOpenSettings={vi.fn()} />);

		const updateButton = screen.getByRole("button", {
			name: "조치가 필요한 업데이트 1개",
		});
		expect(updateButton).toBeTruthy();

		act(() => dismissUpdateNotice("source.fixture"));

		expect(
			screen.getByRole("button", {
				name: "조치가 필요한 업데이트 1개",
			}),
		).toBeTruthy();
		act(() => updateButton.click());
		expect(updateNoticeSnapshot().notices[0]?.dismissed).toBe(false);
		// With the card on screen the badge puts it away; the count stays.
		act(() => updateButton.click());
		expect(updateNoticeSnapshot().notices[0]?.dismissed).toBe(true);
		expect(updateNoticeSnapshot().unresolvedCount).toBe(1);
		act(() => updateButton.click());
		expect(updateNoticeSnapshot().notices[0]?.dismissed).toBe(false);
	});

	it.each(["disabled", "unconfigured", "no_workspace"])(
		"keeps GitHub visible and selectable when %s while Beads remains hidden",
		(state) => {
			setPermission(false);
			if (state === "unconfigured") permissionMocks.permission = null;
			if (state === "no_workspace") useStore.setState({ focusCtx: null });
			useWindowSidebarStore.setState({ open: false, tab: "spaces" });
			const onOpenPluginContainer = vi.fn();
			const githubContainer = {
				...beadsContainer,
				plugin: {
					...beadsContainer.plugin,
					manifest: { ...beadsContainer.plugin.manifest, id: "dure.github" },
				},
				contributionId: "dure.github.views",
				container: {
					...beadsContainer.container,
					id: "dure.github.issues",
					title: { default: "GitHub", translations: {} },
					icon: "github" as const,
				},
			};
			render(
				<ActivityRail
					onOpenSettings={vi.fn()}
					pluginContainers={[githubContainer, beadsContainer]}
					onOpenPluginContainer={onOpenPluginContainer}
				/>,
			);
			const button = screen.getByRole("button", { name: "GitHub" });
			expect(button.innerHTML).toContain("M9 18c-4.51 2-5-2-7-2");
			expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
			act(() => button.click());
			expect(onOpenPluginContainer).toHaveBeenCalledWith(
				pluginSidebarContainerKey(githubContainer),
			);
			expect(useWindowSidebarStore.getState().tab).toBe("plugin");
			expect(useWindowSidebarStore.getState().open).toBe(true);
		},
	);

	it("shows contributed plugin views separately from plugin management", () => {
		render(
			<ActivityRail
				onOpenSettings={vi.fn()}
				pluginContainers={[beadsContainer]}
			/>,
		);

		expect(screen.getAllByRole("button", { name: "플러그인" })).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Beads" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "에이전트 계정" })).toBeNull();
	});

	it.each(["unconfigured", "disabled", "review_changed"])(
		"hides a %s plugin while keeping plugin management available",
		(state) => {
			setPermission(false);
			if (state === "unconfigured") permissionMocks.permission = null;
			if (state === "review_changed") {
				permissionMocks.permission = {
					enabled: true,
					plan_comparison: "changed_since_review",
				} as DurePluginPermissionSnapshot;
			}
			render(<ActivityRail onOpenSettings={vi.fn()} pluginContainers={[beadsContainer]} />);
			expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
			expect(screen.getByRole("button", { name: t("common.plugin") })).toBeTruthy();
		},
	);

	it("shows and removes the plugin button as workspace enablement changes", () => {
		setPermission(false);
		const view = <ActivityRail onOpenSettings={vi.fn()} pluginContainers={[beadsContainer]} />;
		const rendered = render(view);
		expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
		setPermission(true);
		rendered.rerender(<ActivityRail onOpenSettings={vi.fn()} pluginContainers={[beadsContainer]} />);
		expect(screen.getByRole("button", { name: "Beads" })).toBeTruthy();
		setPermission(false);
		rendered.rerender(<ActivityRail onOpenSettings={vi.fn()} pluginContainers={[beadsContainer]} />);
		expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
	});

	it("resolves permission against the focused workspace and never a remote path", () => {
		render(<ActivityRail onOpenSettings={vi.fn()} pluginContainers={[beadsContainer]} />);
		expect(permissionMocks.usePermission).toHaveBeenLastCalledWith({
			pluginId: "dure.beads", workspaceRoot: "/work/repo",
		});
		act(() => useStore.setState({
			focusCtx: { cwd: "/work/other", source: "local", label: "other" },
		}));
		expect(permissionMocks.usePermission).toHaveBeenLastCalledWith({
			pluginId: "dure.beads", workspaceRoot: "/work/other",
		});
		act(() => useStore.setState({
			focusCtx: { cwd: "/work/other", source: "ssh", hostId: "remote", label: "remote" },
		}));
		expect(permissionMocks.usePermission).toHaveBeenLastCalledWith(null);
		expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
		act(() => useStore.setState({ focusCtx: null }));
		expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
	});

	it("opens the selected contributed container through the generic plugin tab", () => {
		const onOpenPluginContainer = vi.fn();
		useWindowSidebarStore.setState({ open: true, tab: "spaces" });
		render(
			<ActivityRail
				onOpenSettings={vi.fn()}
				pluginContainers={[beadsContainer]}
				onOpenPluginContainer={onOpenPluginContainer}
			/>,
		);

		screen.getByRole("button", { name: "Beads" }).click();
		expect(onOpenPluginContainer).toHaveBeenCalledWith(
			pluginSidebarContainerKey(beadsContainer),
		);
		expect(useWindowSidebarStore.getState().tab).toBe("plugin");
	});

	it("keeps equal container ids from separate view contributions selectable", () => {
		const alternate = {
			...beadsContainer,
			contributionId: "dure.beads.alternate-views",
			container: {
				...beadsContainer.container,
				title: { default: "Beads alternate" },
			},
		} as DurePluginViewContainer;
		const onOpenPluginContainer = vi.fn();
		render(
			<ActivityRail
				onOpenSettings={vi.fn()}
				pluginContainers={[beadsContainer, alternate]}
				onOpenPluginContainer={onOpenPluginContainer}
			/>,
		);

		screen.getByRole("button", { name: "Beads alternate" }).click();
		expect(onOpenPluginContainer).toHaveBeenCalledWith(
			pluginSidebarContainerKey(alternate),
		);
});

	it("draws Source control with the branch glyph, not the GitHub mark", () => {
		// The panel is the app's own git — worktrees, branches, commits — so its
		// symbol is the branch. The octocat means the GitHub service and stays
		// with GitHub-specific surfaces (owner decision 2026-09-03).
		useWindowSidebarStore.setState({ open: true, tab: "spaces" });
		render(<ActivityRail onOpenSettings={vi.fn()} />);
		const button = screen.getByRole("button", {
			name: t("common.sourceControl"),
		});
		const glyph = button.querySelector("svg");
		expect(glyph?.getAttribute("class")).toContain("lucide-git-branch");
		expect(button.innerHTML).not.toContain("M9 18c-4.51 2-5-2-7-2");
	});

	it("folds optional rail tabs in basic mode while keeping Sessions and Source control visible", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
		}));
		useWindowSidebarStore.setState({ open: true, tab: "automations" });
		render(<ActivityRail onOpenSettings={vi.fn()} />);

		// Source control is core, not a pro surface (owner decision 2026-09-03).
		expect(
			screen.getByRole("button", { name: t("common.sourceControl") }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: t("common.session") }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: t("common.plugin") }),
		).toBeTruthy();
		// The persisted Automations selection reads as spaces: the chip moves
		// with the panel instead of leaving no tab selected.
		expect(
			screen.getByRole("button", { name: /스페이스|Space/ }).getAttribute(
				"aria-pressed",
			),
		).toBe("true");
	});

	it("keeps a persisted Sessions selection active in basic mode", () => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
		}));
		useWindowSidebarStore.setState({ open: true, tab: "recovery" });
		render(<ActivityRail onOpenSettings={vi.fn()} />);

		expect(
			screen
				.getByRole("button", { name: t("common.session") })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			screen
				.getByRole("button", { name: /스페이스|Space/ })
				.getAttribute("aria-pressed"),
		).toBe("false");
	});

	it.each(["basic", "production"])("opens and toggles SSH without existing hosts under %s policy", (policy) => {
		if (policy === "production") vi.stubEnv("PROD", true);
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" as const },
			sshHosts: [],
			projects: [],
		}));
		useWindowSidebarStore.setState({ open: false, tab: "spaces" });
		render(<ActivityRail onOpenSettings={vi.fn()} />);

		const ssh = screen.getByRole("button", { name: "SSH" });
		act(() => ssh.click());
		expect(useWindowSidebarStore.getState().tab).toBe("ssh");
		expect(useWindowSidebarStore.getState().open).toBe(true);
		expect(ssh.getAttribute("aria-pressed")).toBe("true");
		expect(ssh.getAttribute("aria-expanded")).toBe("true");
		act(() => ssh.click());
		expect(useWindowSidebarStore.getState().tab).toBe("ssh");
		expect(useWindowSidebarStore.getState().open).toBe(false);
		expect(ssh.getAttribute("aria-pressed")).toBe("true");
		expect(ssh.getAttribute("aria-expanded")).toBe("false");
	});
});
