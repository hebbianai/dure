/**
 * "새 에이전트" 화면이 무엇을 말하고 무엇을 못 누르게 하는지.
 * Figma `dure-UI` 3172:81560 / 3177:82234.
 *
 * 대부분의 시험이 **못 누르는 것**에 대한 것이다. 목록에서 빼 버리면 사람은 왜
 * 없는지 알 수 없고, 빼지 않은 채로 누르게 두면 거절만 돌아온다.
 */

import { describe, expect, it, vi } from "vitest";
import { t } from "./i18n";
import type { LaunchOffer, LaunchOfferTarget, StartAgentOutcome } from "./ipc";
import { emptyForm } from "./launch";
import {
	type LaunchActions,
	type LaunchModel,
	renderLaunchScreen,
} from "./launchView";

function target(
	id: string,
	space: string,
	folder: string,
	startable = true,
): LaunchOfferTarget {
	return {
		id,
		space_label: space,
		folder_label: folder,
		box_label: startable ? "" : "vps-1",
		path_hint: `~/dev/${folder}`,
		startable,
	};
}

const OFFER: LaunchOffer = {
	published: true,
	targets: [
		target("s1 p1", "Main", "HebbianIDE"),
		target("s1 p2", "Main", "dure-app", false),
		target("s2 p1", "Onchain", "payments"),
	],
	kinds: [
		{ id: "claude", label: "Claude Code", installed: true },
		{ id: "gemini", label: "Gemini", installed: false },
	],
};

function actions(over: Partial<LaunchActions> = {}): LaunchActions {
	return {
		close: vi.fn(),
		openMenu: vi.fn(),
		selectSpace: vi.fn(),
		selectFolder: vi.fn(),
		selectKind: vi.fn(),
		toggleWorktree: vi.fn(),
		editBranch: vi.fn(),
		addFolder: vi.fn(),
		start: vi.fn(),
		again: vi.fn(),
		open: vi.fn(),
		...over,
	};
}

function model(over: Partial<LaunchModel> = {}): LaunchModel {
	return {
		stage: { kind: "ready", offer: OFFER },
		form: {
			...emptyForm(),
			spaceLabel: "Main",
			targetId: "s1 p1",
			kindId: "claude",
		},
		menu: undefined,
		boxLabel: "MacBook",
		...over,
	};
}

const startButton = (screen: HTMLElement) =>
	screen.querySelector<HTMLButtonElement>(".launch__start");

describe("remote launch form", () => {
	const remote = (id: string) => ({
		...target(id, "Main", id),
		box_label: id,
		worktree_supported: false,
		provider_installation: "check_on_start" as const,
	});
	const offer = { ...OFFER, targets: [OFFER.targets[0]!, remote("aws"), remote("tailscale")] };
	const selected = { ...model().form, targetId: "aws", kindId: "gemini", branch: "agent/remote" };
	const render = (form = selected, callbacks = actions()) =>
		renderLaunchScreen(model({ stage: { kind: "ready", offer }, form }), callbacks);

	it("enables remote canonical kinds and explains that installation is checked at Start", () => {
		const selectKind = vi.fn();
		const screen = render(selected, actions({ selectKind }));
		const gemini = screen.querySelectorAll<HTMLButtonElement>(".launch-chip")[1];
		expect(gemini?.disabled).toBe(false);
		gemini?.click();
		expect(selectKind).toHaveBeenCalledWith("gemini");
		expect(screen.querySelector(".launch__why")?.textContent).toBe(t("launch.provider.checkOnStart", { host: "aws" }));
		expect(screen.textContent).not.toContain(t("흐린 것은 이 컴퓨터에 설치되어 있지 않습니다"));
	});

	it("keeps the selected provider while target changes recompute chip and Start eligibility", () => {
		for (const [targetId, allowed] of [["s1 p1", false], ["aws", true], ["tailscale", true], ["s1 p1", false]] as const) {
			const screen = render({ ...selected, targetId, useWorktree: false });
			const gemini = screen.querySelectorAll<HTMLButtonElement>(".launch-chip")[1];
			expect(gemini?.getAttribute("aria-pressed")).toBe("true");
			expect(gemini?.disabled).toBe(!allowed);
			expect(startButton(screen)?.disabled).toBe(!allowed);
		}
	});

	it("keeps unsupported worktree on until the user turns it off, then offers original-folder start", () => {
		const toggleWorktree = vi.fn();
		const screen = render({ ...selected, kindId: "claude" }, actions({ toggleWorktree }));
		const toggle = screen.querySelector<HTMLButtonElement>(".launch-switch");
		expect(toggle?.getAttribute("aria-checked")).toBe("true");
		expect(toggle?.disabled).toBe(false);
		expect(startButton(screen)?.disabled).toBe(true);
		expect(screen.querySelector(".launch-worktree__hint")?.textContent).toBe(t("launch.worktree.unsupported"));
		expect(screen.querySelector(".launch-branch")).toBeNull();
		toggle?.click();
		expect(toggleWorktree).toHaveBeenCalledWith(false);
		const off = render({ ...selected, useWorktree: false });
		expect(startButton(off)?.disabled).toBe(false);
		expect(off.querySelector(".launch-worktree__hint")?.textContent).toBe(t("launch.worktree.originalFolder"));
		expect(off.querySelector<HTMLButtonElement>(".launch-switch")?.disabled).toBe(true);
	});

	it("returns to local capabilities for a browsed folder, not the SSH anchor's capabilities", () => {
		const screen = render({ ...selected, folderPath: "/Users/me/new", folderLabel: "new" });
		expect(screen.querySelectorAll<HTMLButtonElement>(".launch-chip")[1]?.disabled).toBe(true);
		expect(startButton(screen)?.disabled).toBe(true);
		expect(screen.querySelector(".launch-branch")).not.toBeNull();
		expect(screen.querySelector(".launch-worktree__hint")?.textContent).toBe(t("메인 브랜치를 건드리지 않습니다"));
	});
});

describe("renderLaunchScreen", () => {
	/** 시안은 스페이스와 폴더를 따로 묻는다. 사람이 고르는 것은 언제나 둘이다. */
	it("스페이스와 폴더를 각각의 줄로 묻는다", () => {
		const screen = renderLaunchScreen(model(), actions());
		const labels = [...screen.querySelectorAll(".launch-field__label")].map(
			(node) => node.textContent,
		);

		expect(labels).toEqual([t("스페이스"), t("폴더"), t("에이전트")]);
		const values = [...screen.querySelectorAll(".launch-field__value")].map(
			(node) => node.textContent,
		);
		expect(values).toEqual(["Main", "HebbianIDE"]);
	});

	/** 같은 이름의 폴더 둘을 사람이 가르는 곳이라, 기계와 경로를 함께 적는다. */
	it("고른 폴더 아래에 어느 기계의 어느 경로인지 적는다", () => {
		const screen = renderLaunchScreen(model(), actions());

		expect(screen.querySelector(".launch-field__meta")?.textContent).toBe(
			"MacBook · ~/dev/HebbianIDE",
		);
	});

	it("브라우저에서 고른 폴더와 홈 기준 경로를 같은 줄에 돌려준다", () => {
		const screen = renderLaunchScreen(
			model({
				form: {
					...emptyForm(),
					spaceLabel: "Main",
					targetId: "s1 p1",
					kindId: "claude",
					folderPath: "/Users/me/Dev",
					folderLabel: "Dev",
					folderHint: "~/Dev",
				},
			}),
			actions(),
		);

		expect(screen.querySelector(".launch-field__folder")?.textContent).toContain(
			"DevMacBook · ~/Dev",
		);
	});

	it("폴더 목록을 펼치면 그 스페이스의 폴더만 선다", () => {
		const screen = renderLaunchScreen(model({ menu: "folder" }), actions());
		const items = [...screen.querySelectorAll(".launch-menu__name")].map(
			(node) => node.textContent,
		);

		expect(items).toEqual(["HebbianIDE", "dure-app"]);
	});

	/** 없는 폴더와 지금은 안 되는 폴더는 다른 사실이다. */
	it("원격 폴더를 목록에서 지우지 않고 못 누르게만 한다", () => {
		const screen = renderLaunchScreen(model({ menu: "folder" }), actions());
		const rows = [
			...screen.querySelectorAll<HTMLButtonElement>(".launch-menu__item"),
		];

		expect(rows).toHaveLength(2);
		expect(rows[1]?.disabled).toBe(true);
		expect(rows[1]?.textContent).toContain("vps-1");
	});

	it("폴더 목록 끝에 다른 폴더 열기를 붙인다", () => {
		const addFolder = vi.fn();
		const screen = renderLaunchScreen(
			model({ menu: "folder" }),
			actions({ addFolder }),
		);
		screen.querySelector<HTMLButtonElement>(".launch-menu__add")?.click();

		expect(addFolder).toHaveBeenCalled();
		expect(screen.querySelector(".launch-menu__add")?.textContent).toContain(
			t("다른 폴더 열기..."),
		);
	});

	it("스페이스 목록은 스페이스만 편다", () => {
		const screen = renderLaunchScreen(model({ menu: "space" }), actions());

		expect(
			[...screen.querySelectorAll(".launch-menu__name")].map(
				(node) => node.textContent,
			),
		).toEqual(["Main", "Onchain"]);
	});

	it("고른 에이전트는 채우고, 없는 것은 못 고르게 한다", () => {
		const screen = renderLaunchScreen(model(), actions());
		const chips = [
			...screen.querySelectorAll<HTMLButtonElement>(".launch-chip"),
		];

		expect(chips[0]?.classList.contains("launch-chip--on")).toBe(true);
		expect(chips[1]?.disabled).toBe(true);
	});

	/** 폰에는 hover 가 없다. title 에만 적힌 이유는 어떤 손짓으로도 안 읽힌다. */
	it("못 고르는 에이전트의 이유를 눈에 보이게 적는다", () => {
		const screen = renderLaunchScreen(model(), actions());

		expect(screen.querySelector(".launch__why")?.textContent).toBe(
			t("흐린 것은 이 컴퓨터에 설치되어 있지 않습니다"),
		);
	});

	describe("worktree", () => {
		it("기본은 켬이고, 브랜치 칸을 함께 그린다", () => {
			const screen = renderLaunchScreen(model(), actions());
			const toggle = screen.querySelector<HTMLButtonElement>(".launch-switch");

			expect(toggle?.getAttribute("aria-checked")).toBe("true");
			expect(
				screen.querySelector<HTMLInputElement>(".launch-branch")?.value,
			).toBe("agent/");
		});

		/**
		 * 브랜치를 치는 동안 화면을 다시 그리지 않으므로(폰에서는 그것이 키보드가
		 * 닫히는 것으로 보인다), 그 값에 매달린 시작 버튼은 이 칸이 직접 갱신해야
		 * 한다 — 아니면 유효한 이름을 다 쳐도 버튼이 꺼진 채로 남는다.
		 */
		it("브랜치를 치면 시작 버튼 판정이 그 자리에서 따라온다", () => {
			const screen = renderLaunchScreen(
				model({
					form: {
						...emptyForm(),
						spaceLabel: "Main",
						targetId: "s1 p1",
						kindId: "claude",
					},
				}),
				actions(),
			);
			const input = screen.querySelector<HTMLInputElement>(".launch-branch");
			if (!input) throw new Error("no branch input");

			// `agent/` 뿐인 기본값은 아직 시작할 수 없다.
			expect(startButton(screen)?.disabled).toBe(true);

			input.value = "agent/pairing";
			input.dispatchEvent(new Event("input"));

			expect(startButton(screen)?.disabled).toBe(false);
		});

		/** 끈 상태에서 칸을 남겨 두면, 쓰지 않을 값을 고치게 된다. */
		it("끄면 브랜치 칸이 사라진다", () => {
			const off = renderLaunchScreen(
				model({
					form: {
						...emptyForm(),
						useWorktree: false,
						targetId: "s1 p1",
						kindId: "claude",
					},
				}),
				actions(),
			);

			expect(off.querySelector(".launch-branch")).toBeNull();
			expect(
				off.querySelector(".launch-switch")?.getAttribute("aria-checked"),
			).toBe("false");
		});

		it("토글을 누르면 반대값을 알린다", () => {
			const toggleWorktree = vi.fn();
			const screen = renderLaunchScreen(model(), actions({ toggleWorktree }));
			screen.querySelector<HTMLButtonElement>(".launch-switch")?.click();

			expect(toggleWorktree).toHaveBeenCalledWith(false);
		});
	});

	describe("시작 단추", () => {
		it("접두사만 남은 브랜치로는 켜지지 않는다", () => {
			expect(
				startButton(renderLaunchScreen(model(), actions()))?.disabled,
			).toBe(true);
		});

		it("고를 것을 다 고르면 켜진다", () => {
			const ready = renderLaunchScreen(
				model({
					form: {
						...emptyForm(),
						branch: "agent/x",
						spaceLabel: "Main",
						targetId: "s1 p1",
						kindId: "claude",
					},
				}),
				actions(),
			);

			expect(startButton(ready)?.disabled).toBe(false);
		});

		it("보내는 동안에는 다시 누를 수 없다", () => {
			const busy = renderLaunchScreen(
				model({ stage: { kind: "starting", offer: OFFER } }),
				actions(),
			);

			expect(startButton(busy)?.disabled).toBe(true);
		});
	});

	/**
	 * 띄웠는데 세션 id 가 없을 수 있다 — 제공자에 따라 나중에 생긴다. 아무 데도
	 * 안 가는 "열기" 를 그리는 것보다, 곧 나타난다고 말하는 편이 낫다.
	 */
	it("세션 id 없이 뜬 것은 성공으로 말하되 열기를 내밀지 않는다", () => {
		const outcome: StartAgentOutcome = {
			started: true,
			agent_id: "a1",
			session_id: null,
			detail: null,
			code: null,
		};
		const screen = renderLaunchScreen(
			model({ stage: { kind: "done", offer: OFFER, outcome } }),
			actions(),
		);

		expect(screen.querySelector(".launch-outcome")?.textContent).toContain(
			t("에이전트를 띄웠습니다"),
		);
		expect(screen.textContent).toContain(t("곧 목록에 나타납니다"));
		expect(screen.textContent).not.toContain(t("열기"));
	});

	it("세션 id 가 오면 그 세션을 연다", () => {
		const open = vi.fn();
		const outcome: StartAgentOutcome = {
			started: true,
			agent_id: "a1",
			session_id: "sess-1",
			detail: null,
			code: null,
		};
		const screen = renderLaunchScreen(
			model({ stage: { kind: "done", offer: OFFER, outcome } }),
			actions({ open }),
		);
		screen
			.querySelector<HTMLButtonElement>(".launch-outcome .pair-button")
			?.click();

		expect(open).toHaveBeenCalledWith("sess-1");
	});

	it("거절은 노트북이 말한 이유를 그대로 적는다", () => {
		const outcome: StartAgentOutcome = {
			started: false,
			agent_id: null,
			session_id: null,
			detail: "그 폴더는 이 컴퓨터의 목록에 더 이상 없습니다.",
			code: "target_missing",
		};
		const screen = renderLaunchScreen(
			model({ stage: { kind: "done", offer: OFFER, outcome } }),
			actions(),
		);

		expect(screen.querySelector(".launch-outcome--no")?.textContent).toContain(
			"그 폴더는 이 컴퓨터의 목록에 더 이상 없습니다.",
		);
	});

	/** 기다리면 되는 것과 노트북에 가서 할 일이 있는 것은 다른 상태다. */
	it("아직 안 보낸 목록과 정말로 빈 목록을 다르게 말한다", () => {
		const waiting = renderLaunchScreen(
			model({
				stage: {
					kind: "ready",
					offer: { published: false, targets: [], kinds: [] },
				},
			}),
			actions(),
		);
		const empty = renderLaunchScreen(
			model({
				stage: {
					kind: "ready",
					offer: { published: true, targets: [], kinds: [] },
				},
			}),
			actions(),
		);

		expect(waiting.querySelector(".launch__empty")?.textContent).not.toBe(
			empty.querySelector(".launch__empty")?.textContent,
		);
	});
});
