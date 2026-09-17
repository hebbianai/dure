// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { OnboardingImportPreview } from "@/components/onboarding/OnboardingImportPreview";
import type { ProviderConversationDiscoverySnapshot } from "@/lib/agents/providerConversationDiscovery";

import { DEFAULT_UI_PREFS, useStore } from "@/store";

const mocks = vi.hoisted(() => ({
	apply: vi.fn(),
	projectionTotal: 2,
	includeOlderSession: false,
	firstGroupItemCount: 1,
	discover: vi.fn(
		async (
			_hosts: readonly unknown[],
			onUpdate: (snapshot: ProviderConversationDiscoverySnapshot) => void,
		) => {
			const snapshot: ProviderConversationDiscoverySnapshot = {
				records: [],
				sources: [
					{
						key: "local",
						kind: "local" as const,
						status: "succeeded" as const,
						count: 2,
					},
				],
				complete: true,
			};
			onUpdate(snapshot);
			return snapshot;
		},
	),
}));

vi.mock("@/lib/onboarding/onboardingImportApply", () => ({
	applyOnboardingImportDraft: mocks.apply,
}));

vi.mock("@/lib/i18n", () => ({
	// Key-passthrough mock: a semantic ID key renders as its ID. Interpolation
	// values are appended as `name=value` so assertions can still observe
	// state-dependent copy (selection counts, error text) per call site.
	t: (key: string, values?: Record<string, string | number>) => {
		const entries = Object.entries(values ?? {});
		if (entries.length === 0) return key;
		const suffix = entries
			.map(([name, value]) => `${name}=${String(value)}`)
			.join(" ");
		return `${key} ${suffix}`;
	},
}));

vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: vi.fn().mockResolvedValue([{}]),
	discoverProviderConversationsProgressively: mocks.discover,
}));

vi.mock("@/lib/sessions/recentWork", () => ({
	projectRecentWork: () => ({
		total: mocks.projectionTotal,
		groups: [
			{
				id: "repo:first",
				name: "First",
				cwd: "/first",
				items: [
					...Array.from({ length: mocks.firstGroupItemCount }, (_, index) => ({
						key: `codex:first-${index}`,
						conversationId: `first-${index}`,
						title: index === 0 ? "First session" : `First session ${index + 1}`,
						mtime: Date.now() / 1000 - index,
						provider: "codex" as const,
						cwd: `/first/${index}`,
						workspaceRoot: "/first",
						groupIdentity: "repo:first",
						defaultSelected: true,
						repositoryCommonDir: "/first/.git",
						executionLocation:
							index === 8 ? ("ssh" as const) : ("local" as const),
						...(index === 8 ? { hostId: "ssh-dev" } : {}),
					})),
					...(mocks.includeOlderSession
						? [
								{
									key: "codex:first-older",
									conversationId: "first-older",
									title: "Older first session",
									mtime: Date.now() / 1000 - 8 * 24 * 60 * 60,
									provider: "codex" as const,
									cwd: "/first/older",
									workspaceRoot: "/first",
									groupIdentity: "repo:first",
									defaultSelected: false,
									executionLocation: "local" as const,
								},
							]
						: []),
				],
			},
			{
				id: "repo:second",
				name: "Second",
				cwd: "/second",
				items: [
					{
						key: "claude:second",
						conversationId: "second",
						title: "Second session",
						mtime: Date.now() / 1000 - 1,
						provider: "claude",
						cwd: "/second",
						workspaceRoot: "/second",
						groupIdentity: "repo:second",
						defaultSelected: true,
						executionLocation: "local",
					},
				],
			},
		],
	}),
}));

function dataTransfer() {
	const values = new Map<string, string>();
	return {
		effectAllowed: "none",
		dropEffect: "none",
		types: [] as string[],
		setData(type: string, value: string) {
			values.set(type, value);
			if (!this.types.includes(type)) this.types.push(type);
		},
		getData(type: string) {
			return values.get(type) ?? "";
		},
		setDragImage: vi.fn(),
	};
}

afterEach(() => {
	cleanup();
	useStore.setState({ uiPrefs: { ...DEFAULT_UI_PREFS } });
	mocks.apply.mockReset();
	mocks.projectionTotal = 2;
	mocks.includeOlderSession = false;
	mocks.firstGroupItemCount = 1;
	vi.clearAllMocks();
});

describe("OnboardingImportPreview", () => {
	it("lets users choose the default agent before importing sessions", async () => {
		render(<OnboardingImportPreview />);
		fireEvent.click(await screen.findByRole("radio", { name: "Codex" }));
		expect(useStore.getState().uiPrefs.defaultProvider).toBe("codex");
	});

	it("shows local sessions while a remote host is still scanning", async () => {
		let publish:
			| ((snapshot: ProviderConversationDiscoverySnapshot) => void)
			| undefined;
		let resolveDiscovery: (snapshot: ProviderConversationDiscoverySnapshot) => void =
			() => undefined;
		mocks.discover.mockImplementationOnce((_hosts, onUpdate) => {
			publish = onUpdate;
			onUpdate({
				records: [],
				sources: [
					{ key: "local", kind: "local", status: "succeeded", count: 2 },
					{
						key: "ssh:dev",
						kind: "ssh",
						label: "devbox",
						status: "pending",
						count: 0,
					},
				],
				complete: false,
			});
			return new Promise<ProviderConversationDiscoverySnapshot>((resolve) => {
				resolveDiscovery = resolve;
			});
		});

		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");
		const remote = document.querySelector<HTMLElement>(
			'[data-discovery-source="ssh:dev"]',
		);
		expect(remote?.dataset.discoveryStatus).toBe("pending");
		expect(remote?.textContent).toContain("devbox");
		expect(remote?.textContent).toContain("onboarding.import.discovery.scanning");

		const finalSnapshot: ProviderConversationDiscoverySnapshot = {
			records: [],
			sources: [
				{ key: "local", kind: "local" as const, status: "succeeded" as const, count: 2 },
				{
					key: "ssh:dev",
					kind: "ssh" as const,
					label: "devbox",
					status: "failed" as const,
					count: 0,
				},
			],
			complete: true,
		};
		await act(async () => {
			publish?.(finalSnapshot);
			resolveDiscovery(finalSnapshot);
		});
		expect(screen.getByDisplayValue("First")).toBeTruthy();
		expect(
			document.querySelector<HTMLElement>('[data-discovery-source="ssh:dev"]')
				?.dataset.discoveryStatus,
		).toBe("failed");
		expect(screen.getByText("onboarding.import.discovery.failed")).toBeTruthy();
	});

	it("explains how to recover when every discovery source fails", async () => {
		mocks.discover.mockRejectedValueOnce(new Error("scan unavailable"));

		render(<OnboardingImportPreview />);

		expect(await screen.findByText("onboarding.import.discovery.failedTitle")).toBeTruthy();
		expect(
			screen.getByText("onboarding.import.discovery.failedHint"),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "onboarding.import.discovery.retry" })).toBeTruthy();
	});

	it("preserves edits when a refresh discovers another session", async () => {
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		const name = await screen.findByDisplayValue("First");
		fireEvent.change(name, { target: { value: "Core" } });
		fireEvent.click(
			screen.getByRole("button", {
				name: "onboarding.import.space.removePaneAria name=First session",
			}),
		);

		mocks.firstGroupItemCount = 2;
		mocks.projectionTotal = 3;
		fireEvent.click(screen.getByRole("button", { name: "onboarding.import.rebuildDraft" }));

		await screen.findByDisplayValue("Core");
		await waitFor(() =>
			expect(
				within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=2 total=3 desktops=2"),
			).toBeTruthy(),
		);
	});

	it("renders its setup action into the panel-owned action slot", async () => {
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");

		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=2 total=2 desktops=2"),
		).toBeTruthy();
		expect(
			within(actionBarTarget).getByRole("button", { name: "onboarding.import.apply.startWithSessions n=2" }),
		).toBeTruthy();
		expect(
			document
				.querySelector("section")
				?.querySelector("[data-onboarding-import-action-bar]"),
		).toBeNull();
	});

	it("distinguishes discovered conversations from selected panes", async () => {
		mocks.projectionTotal = 54;
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");

		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=2 total=54 desktops=2"),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", {
				name: "onboarding.import.space.removePaneAria name=First session",
			}),
		);
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=1 total=54 desktops=1"),
		).toBeTruthy();
	});

	it("hides sessions older than a week until the full-month scope is chosen", async () => {
		mocks.includeOlderSession = true;
		mocks.projectionTotal = 3;
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");

		const olderSelected = () =>
			document.querySelector(
				'[data-import-pane-key="codex:first-older"][data-selected="true"]',
			) !== null;
		expect(olderSelected()).toBe(false);
		expect(screen.getByText("onboarding.import.toolbar.selectionSummary selected=2 total=2")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "onboarding.import.toolbar.rangeAll" }));
		expect(screen.getByText("onboarding.import.toolbar.selectionSummary selected=3 total=3")).toBeTruthy();
		expect(olderSelected()).toBe(true);
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=3 total=3 desktops=2"),
		).toBeTruthy();

		// 범위를 다시 좁히면 화면에서 사라지는 선택도 함께 걷어낸다.
		fireEvent.click(screen.getByRole("button", { name: "onboarding.import.toolbar.rangeRecent" }));
		expect(olderSelected()).toBe(false);
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=2 total=3 desktops=2"),
		).toBeTruthy();
	});

	it("selects older sessions discovered after the full-month scope is chosen", async () => {
		let publish:
			| ((snapshot: ProviderConversationDiscoverySnapshot) => void)
			| undefined;
		let resolveDiscovery: (snapshot: ProviderConversationDiscoverySnapshot) => void =
			() => undefined;
		const initialSnapshot: ProviderConversationDiscoverySnapshot = {
			records: [],
			sources: [
				{ key: "local", kind: "local", status: "pending", count: 2 },
			],
			complete: false,
		};
		mocks.discover.mockImplementationOnce((_hosts, onUpdate) => {
			publish = onUpdate;
			onUpdate(initialSnapshot);
			return new Promise<ProviderConversationDiscoverySnapshot>((resolve) => {
				resolveDiscovery = resolve;
			});
		});

		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");
		fireEvent.click(screen.getByRole("button", { name: "onboarding.import.toolbar.rangeAll" }));

		mocks.includeOlderSession = true;
		mocks.projectionTotal = 3;
		const completeSnapshot: ProviderConversationDiscoverySnapshot = {
			records: [],
			sources: [
				{ key: "local", kind: "local", status: "succeeded", count: 3 },
			],
			complete: true,
		};
		await act(async () => {
			publish?.(completeSnapshot);
			resolveDiscovery(completeSnapshot);
		});

		expect(
			document.querySelector(
				'[data-import-pane-key="codex:first-older"][data-selected="true"]',
			),
		).not.toBeNull();
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=3 total=3 desktops=2"),
		).toBeTruthy();
	});

	it("disables every space from the toolbar without hiding its sessions", async () => {
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");
		expect(document.querySelectorAll("[data-layout-cell]")).toHaveLength(2);

		fireEvent.click(screen.getByLabelText("onboarding.import.toolbar.selectAll"));
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=0 total=2 desktops=0"),
		).toBeTruthy();
		expect(screen.getByText("onboarding.import.toolbar.selectionSummary selected=0 total=2")).toBeTruthy();
		// 목록이 사라지면 무엇을 껐는지 볼 수 없다 — 카드는 그대로 남고 비활성만 된다.
		expect(document.querySelectorAll("[data-layout-cell]")).toHaveLength(2);
		for (const space of screen.getAllByLabelText("onboarding.import.space.include")) {
			expect((space as HTMLInputElement).checked).toBe(false);
		}
		for (const remove of screen.getAllByRole("button", {
			name: /^onboarding\.import\.space\.removePaneAria /,
		})) {
			expect((remove as HTMLButtonElement).disabled).toBe(true);
		}

		fireEvent.click(screen.getByLabelText("onboarding.import.toolbar.selectAll"));
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=2 total=2 desktops=2"),
		).toBeTruthy();
		expect(document.querySelectorAll("[data-layout-cell]")).toHaveLength(2);
	});

	it("excludes one space without changing the other spaces", async () => {
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");
		const cards = document.querySelectorAll<HTMLElement>("[data-import-desktop-id]");

		fireEvent.click(within(cards[0]).getByLabelText("onboarding.import.space.include"));

		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.selectionSummary selected=1 total=2 desktops=1"),
		).toBeTruthy();
		expect(
			(within(cards[0]).getByLabelText("onboarding.import.space.desktopName") as HTMLInputElement)
				.disabled,
		).toBe(true);
		expect(
			(within(cards[1]).getByLabelText("onboarding.import.space.desktopName") as HTMLInputElement)
				.disabled,
		).toBe(false);
	});

	it("splits one oversized repository into numbered spaces", async () => {
		mocks.firstGroupItemCount = 9;
		mocks.projectionTotal = 10;
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First 1");

		expect(screen.getByDisplayValue("First 2")).toBeTruthy();
		expect(document.querySelectorAll("[data-import-desktop-id]")).toHaveLength(3);
		expect(screen.getByText("ssh-dev")).toBeTruthy();
	});

	it("keeps the portaled setup action disabled when no sessions are selected", async () => {
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");

		fireEvent.click(screen.getByLabelText("onboarding.import.toolbar.selectAll"));

		const action = within(actionBarTarget).getByRole("button", {
			name: "onboarding.import.apply.startWithSessions n=0",
		}) as HTMLButtonElement;
		expect(action.disabled).toBe(true);
		expect(
			// This suite mocks t() as key-passthrough, so a migrated semantic
			// ID key asserts as its ID, not its rendered copy.
			within(actionBarTarget).getByText("common.selectSessionsToStart"),
		).toBeTruthy();
	});

	it("names the desktop whose blank name blocks setup", async () => {
		const actionBarTarget = document.createElement("div");
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		const name = await screen.findByDisplayValue("First");

		fireEvent.change(name, { target: { value: "" } });

		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.desktopNameRequired n=1"),
		).toBeTruthy();
		expect(
			(
				within(actionBarTarget).getByRole("button", {
					name: "onboarding.import.apply.startWithSessions n=2",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("keeps applying and retry states in the portaled action slot", async () => {
		const actionBarTarget = document.createElement("div");
		let rejectApply: (error: Error) => void = () => undefined;
		mocks.apply.mockReturnValue(
			new Promise((_resolve, reject) => {
				rejectApply = reject;
			}),
		);
		render(<OnboardingImportPreview actionBarTarget={actionBarTarget} />);
		await screen.findByDisplayValue("First");

		fireEvent.click(
			within(actionBarTarget).getByRole("button", { name: "onboarding.import.apply.startWithSessions n=2" }),
		);
		const applying = await within(actionBarTarget).findByRole("button", {
			name: "onboarding.import.apply.inProgress",
		});
		expect((applying as HTMLButtonElement).disabled).toBe(true);
		expect(
			within(actionBarTarget).getByText(
				"onboarding.import.apply.inProgressHint",
			),
		).toBeTruthy();

		rejectApply(new Error("test failure"));
		expect(
			await within(actionBarTarget).findByRole("button", {
				name: "onboarding.import.apply.retry",
			}),
		).toBeTruthy();
		expect(
			within(actionBarTarget).getByText("onboarding.import.apply.failed error=Error: test failure"),
		).toBeTruthy();
		expect(
			within(actionBarTarget).getByText(
				"onboarding.import.apply.incompleteHint",
			),
		).toBeTruthy();
	});

	// src/qa/onboardingImportProbe.ts가 이 속성들로 pane을 찾고 토글한다. 배치가
	// 바뀌어도 이 계약이 남아 있어야 QA 프로브가 조용히 멈추지 않는다.
	it("keeps the pane identity contract the QA probe drives", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");

		const panes = () =>
			Array.from(document.querySelectorAll<HTMLElement>("[data-import-pane-key]"));
		expect(panes()).toHaveLength(2);
		for (const pane of panes()) {
			expect(pane.dataset.importLocation).toBe("local");
			expect(pane.dataset.selected).toBe("true");
			expect(pane.querySelector("[data-import-selected-toggle]")).toBeTruthy();
			expect(pane.closest("[data-import-desktop-id]")).toBeTruthy();
		}

		// 빼면 목록 행이 되지만 정체와 토글은 그대로 실려 있어야 한다.
		const first = panes()[0];
		const paneKey = first.dataset.importPaneKey;
		(
			first.querySelector("[data-import-selected-toggle]") as HTMLButtonElement
		).click();
		await waitFor(() => {
			const moved = panes().find((p) => p.dataset.importPaneKey === paneKey);
			expect(moved?.dataset.selected).toBe("false");
			expect(moved?.querySelector("[data-import-selected-toggle]")).toBeTruthy();
			expect(moved?.dataset.importLocation).toBe("local");
		});
		expect(
			document.querySelector("[data-import-overflow-toggle]"),
		).toBeTruthy();
	});

	it("reveals the left-out list as soon as a session is taken out", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");
		expect(document.querySelectorAll("[data-import-pane-row]")).toHaveLength(0);

		fireEvent.click(
			screen.getByRole("button", {
				name: "onboarding.import.space.removePaneAria name=First session",
			}),
		);

		// 뺀 세션이 어디로 갔는지 그 자리에서 보여야 한다 — 접힌 채로 두면 사라진
		// 것처럼 보인다.
		const toggle = screen.getByRole("button", {
			name: "onboarding.import.space.leftOutSummary n=1",
		});
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelectorAll("[data-import-pane-row]")).toHaveLength(1);

		// 펼쳐 준 것이지 고정한 것은 아니다 — 접을 수 있어야 한다.
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelectorAll("[data-import-pane-row]")).toHaveLength(0);
	});

	it("adds an empty space at the bottom of the list", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");

		fireEvent.click(screen.getByRole("button", { name: "onboarding.import.addSpace" }));

		const input = screen.getByDisplayValue("Desktop 1");
		expect(input).toBeTruthy();
		const cards = document.querySelectorAll("[data-import-desktop-id]");
		expect(cards[cards.length - 1].contains(input)).toBe(true);
	});

	it("moves a session by dropping its card onto another space", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");
		const cards = document.querySelectorAll<HTMLElement>(
			"[data-import-desktop-id]",
		);
		const transfer = dataTransfer();
		const sourceCell = cards[0].querySelector<HTMLElement>("[data-layout-cell]");
		if (!sourceCell) throw new Error("layout cells not rendered");

		fireEvent.dragStart(sourceCell, { dataTransfer: transfer });
		fireEvent.dragOver(cards[1], { dataTransfer: transfer });
		fireEvent.drop(cards[1], { dataTransfer: transfer });

		await waitFor(() => {
			expect(within(cards[1]).getAllByText("First session")).not.toHaveLength(0);
		});
		expect(within(cards[0]).queryAllByText("First session")).toHaveLength(0);
	});

	it("drops a left-out session onto another space by dragging its row", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");
		const cards = document.querySelectorAll<HTMLElement>(
			"[data-import-desktop-id]",
		);
		fireEvent.click(
			within(cards[0]).getByRole("button", {
				name: "onboarding.import.space.removePaneAria name=First session",
			}),
		);
		// 빼면 목록이 바로 펼쳐지므로 따로 열 필요가 없다.
		const row = cards[0].querySelector<HTMLElement>("[data-import-pane-row]");
		if (!row) throw new Error("left-out row not rendered");
		const transfer = dataTransfer();

		fireEvent.dragStart(row, { dataTransfer: transfer });
		fireEvent.dragOver(cards[1], { dataTransfer: transfer });
		fireEvent.drop(cards[1], { dataTransfer: transfer });

		// 빠진 세션은 옮겨져도 빠진 채로 남는다 — 받은 스페이스의 목록에서 확인한다.
		await waitFor(() =>
			expect(
				within(cards[1]).getByRole("button", {
					name: "onboarding.import.space.leftOutSummary n=1",
				}),
			).toBeTruthy(),
		);
		fireEvent.click(
			within(cards[1]).getByRole("button", {
				name: "onboarding.import.space.leftOutSummary n=1",
			}),
		);
		expect(within(cards[1]).getAllByText("First session")).not.toHaveLength(0);
		expect(within(cards[0]).queryAllByText("First session")).toHaveLength(0);
	});

	it("advertises a draggable left-out pane with a grab cursor", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");
		fireEvent.click(
			screen.getByRole("button", {
				name: "onboarding.import.space.removePaneAria name=First session",
			}),
		);

		const row = document.querySelector<HTMLElement>("[data-import-pane-row]");
		const action = row?.querySelector<HTMLButtonElement>(
			"[data-import-selected-toggle]",
		);
		if (!row || !action) throw new Error("draggable pane row not rendered");

		expect(row.draggable).toBe(true);
		expect(action.classList).toContain("cursor-grab");
		expect(action.classList).toContain("active:cursor-grabbing");
		expect(action.classList).not.toContain("cursor-pointer");
	});

	it("moves and places a pane directly from the layout schematic", async () => {
		render(<OnboardingImportPreview />);
		await screen.findByDisplayValue("First");
		const cards = document.querySelectorAll<HTMLElement>("[data-import-desktop-id]");
		const sourceCell = cards[0].querySelector<HTMLElement>("[data-layout-cell]");
		const targetCell = cards[1].querySelector<HTMLElement>("[data-layout-cell]");
		if (!sourceCell || !targetCell) throw new Error("layout cells not rendered");
		const transfer = dataTransfer();

		fireEvent.dragStart(sourceCell, { dataTransfer: transfer });
		fireEvent.dragOver(targetCell, { dataTransfer: transfer });
		expect(targetCell.dataset.layoutDropTarget).toBe("true");
		fireEvent.drop(targetCell, { dataTransfer: transfer });

		await waitFor(() => {
			expect(cards[0].querySelectorAll("[data-layout-cell]")).toHaveLength(0);
			expect(cards[1].querySelectorAll("[data-layout-cell]")).toHaveLength(2);
		});
		const titles = Array.from(cards[1].querySelectorAll<HTMLElement>("[data-layout-cell]"))
			.map((cell) => cell.getAttribute("aria-label"));
		expect(titles).toEqual([
			t("onboarding.import.space.paneReorderAria", { n: 1, name: "First session" }),
			t("onboarding.import.space.paneReorderAria", { n: 2, name: "Second session" }),
		]);
	});
});
