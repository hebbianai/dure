import { describe, expect, it } from "vitest";
import type { LaunchOffer, LaunchOfferKind, LaunchOfferTarget } from "./ipc";
import {
	actionIdFor,
	BRANCH_PREFIX,
	canStart,
	emptyForm,
	emptyOfferMessage,
	foldersOf,
	newActionId,
	preselect,
	retryKeepsActionId,
	selectSpace,
	spacesOf,
} from "./launch";

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

function kind(id: string, label: string, installed = true): LaunchOfferKind {
	return { id, label, installed };
}

function offer(over: Partial<LaunchOffer> = {}): LaunchOffer {
	return { published: true, targets: [], kinds: [], ...over };
}

const READY = offer({
	targets: [
		target("s1 p1", "Main", "HebbianIDE"),
		target("s1 p2", "Main", "dure-app", false),
		target("s2 p1", "Onchain", "HebbianIDE"),
	],
	kinds: [kind("claude", "Claude"), kind("codex", "Codex", false)],
});

describe("spacesOf / foldersOf", () => {
	/** 노트북 사이드바의 순서이고, 사람이 거기서 외운 순서다. */
	it("받은 순서 그대로의 스페이스를 준다", () => {
		expect(spacesOf(READY)).toEqual(["Main", "Onchain"]);
	});

	it("고른 스페이스의 폴더만 준다", () => {
		expect(foldersOf(READY, "Main").map((one) => one.folder_label)).toEqual([
			"HebbianIDE",
			"dure-app",
		]);
		expect(foldersOf(READY, "Onchain")).toHaveLength(1);
	});
});

describe("preselect", () => {
	it("첫 스페이스와 그 안의 띄울 수 있는 첫 폴더, 설치된 첫 에이전트를 고른다", () => {
		expect(preselect(READY)).toEqual({
			spaceLabel: "Main",
			targetId: "s1 p1",
			kindId: "claude",
		});
	});

	/** 흐린 것이 골라져 있으면 누를 수 있어 보인다. */
	it("못 고르는 것은 미리 고르지 않는다", () => {
		const none = offer({
			targets: [target("s1 p2", "Main", "dure-app", false)],
			kinds: [kind("codex", "Codex", false)],
		});

		expect(preselect(none)).toEqual({ spaceLabel: "Main" });
	});
});

describe("selectSpace", () => {
	/** 고른 폴더는 다른 스페이스 것이라 따라올 수 없다. */
	it("스페이스를 바꾸면 폴더를 그 스페이스의 것으로 되돌린다", () => {
		const form = { ...emptyForm(), spaceLabel: "Main", targetId: "s1 p1" };

		expect(selectSpace(READY, form, "Onchain")).toMatchObject({
			spaceLabel: "Onchain",
			targetId: "s2 p1",
		});
	});
});

describe("canStart", () => {
	const base = { ...emptyForm(), branch: "agent/x" };

	it("쓸 수 있는 폴더와 에이전트가 다 골라졌을 때만 켜진다", () => {
		expect(
			canStart(READY, { ...base, targetId: "s1 p1", kindId: "claude" }),
		).toBe(true);
		expect(canStart(READY, { ...base, targetId: "s1 p1" })).toBe(false);
		expect(canStart(READY, { ...base, kindId: "claude" })).toBe(false);
	});

	it("원격 폴더와 설치되지 않은 에이전트로는 켜지지 않는다", () => {
		expect(
			canStart(READY, { ...base, targetId: "s1 p2", kindId: "claude" }),
		).toBe(false);
		expect(
			canStart(READY, { ...base, targetId: "s1 p1", kindId: "codex" }),
		).toBe(false);
	});

	/** 목록이 갱신되면서 고른 것이 사라질 수 있다. 그때 버튼이 살아 있으면
	 *  눌러도 거절만 돌아온다. */
	it("고른 폴더가 목록에서 사라지면 꺼진다", () => {
		expect(
			canStart(offer({ kinds: READY.kinds }), {
				...base,
				targetId: "s1 p1",
				kindId: "claude",
			}),
		).toBe(false);
	});

	/**
	 * worktree 를 켰으면 브랜치가 있어야 한다. `agent/` 하나는 브랜치 이름이
	 * 아니고, 그대로 보내면 노트북이 만들다 실패한다.
	 */
	it("worktree 를 켜 두고 접두사만 남았으면 꺼진다", () => {
		const chosen = { targetId: "s1 p1", kindId: "claude" };

		expect(canStart(READY, { ...emptyForm(), ...chosen })).toBe(false);
		expect(
			canStart(READY, { ...emptyForm(), ...chosen, branch: "agent/" }),
		).toBe(false);
		expect(
			canStart(READY, { ...emptyForm(), ...chosen, branch: "agent/x/" }),
		).toBe(false);
		expect(
			canStart(READY, { ...emptyForm(), ...chosen, branch: "agent/x" }),
		).toBe(true);
	});

	/** 끈 상태에서는 브랜치를 안 쓰므로 비어 있어도 된다. */
	it("worktree 를 끄면 브랜치를 묻지 않는다", () => {
		expect(
			canStart(READY, {
				useWorktree: false,
				branch: "",
				targetId: "s1 p1",
				kindId: "claude",
			}),
		).toBe(true);
	});
});

describe("emptyForm", () => {
	/** 시안의 토글은 켜져 있고, 칸에는 접두사가 들어 있다. */
	it("worktree 를 켠 채로, 저장소가 쓰는 접두사로 시작한다", () => {
		expect(emptyForm()).toEqual({ useWorktree: true, branch: BRANCH_PREFIX });
		expect(BRANCH_PREFIX).toBe("agent/");
	});
});

describe("target-scoped launch capabilities", () => {
	const remote = (id: string) => ({
		...target(id, "Remote", id),
		box_label: id,
		worktree_supported: false,
		provider_installation: "check_on_start" as const,
	});
	const mixed = offer({
		targets: [...READY.targets, remote("aws"), remote("tailscale")],
		kinds: READY.kinds,
	});
	const chosen = {
		...emptyForm(),
		targetId: "aws",
		kindId: "codex",
		useWorktree: false,
	};

	it("permits a canonical remote provider absent from the Mac without changing the selection", () => {
		expect(canStart(mixed, chosen)).toBe(true);
		expect(chosen.kindId).toBe("codex");
		expect(canStart(mixed, { ...chosen, kindId: "unknown" })).toBe(false);
	});

	it("recomputes local/AWS/Tailscale eligibility without carrying foreign installation facts", () => {
		expect(canStart(mixed, { ...chosen, targetId: "s1 p1" })).toBe(false);
		expect(canStart(mixed, { ...chosen, targetId: "aws" })).toBe(true);
		expect(canStart(mixed, { ...chosen, targetId: "tailscale" })).toBe(true);
		expect(canStart(mixed, { ...chosen, targetId: "s1 p1" })).toBe(false);
	});

	it("requires deliberately disabling an unsupported worktree, even with a valid branch", () => {
		const worktree = {
			...chosen, kindId: "claude", useWorktree: true, branch: "agent/remote",
		};
		expect(canStart(mixed, worktree)).toBe(false);
		expect(worktree.useWorktree).toBe(true);
		expect(canStart(mixed, { ...worktree, useWorktree: false })).toBe(true);
	});

	it("uses local installation and worktree capability for a browsed local path anchored to SSH", () => {
		const browsed = {
			...chosen, folderPath: "/Users/me/new", useWorktree: true, branch: "agent/local",
		};
		expect(canStart(mixed, browsed)).toBe(false);
		expect(canStart(mixed, { ...browsed, kindId: "claude" })).toBe(true);
		expect(canStart(mixed, { ...browsed, targetId: "missing", kindId: "claude" })).toBe(false);
		const unavailableAnchor = {
			...mixed,
			targets: mixed.targets.map((target) => ({ ...target, startable: false })),
		};
		expect(canStart(unavailableAnchor, { ...browsed, kindId: "claude" })).toBe(true);
	});

	it("preselects from the selected remote target's eligible canonical kinds", () => {
		const remoteOnly = offer({
			targets: [remote("aws")], kinds: [kind("codex", "Codex", false)],
		});
		expect(preselect(remoteOnly)).toMatchObject({
			targetId: "aws",
			kindId: "codex",
		});
	});

	it("keeps uncertain retry identity for the same remote choice and renews it for explicit changes", () => {
		const press = { ...chosen, actionId: "remote-press" };
		expect(actionIdFor(press, chosen, () => "new-press")).toBe("remote-press");
		expect(actionIdFor(press, { ...chosen, targetId: "tailscale" }, () => "new-press")).toBe("new-press");
		expect(actionIdFor(press, { ...chosen, useWorktree: true }, () => "new-press")).toBe("new-press");
		expect(actionIdFor(press, { ...chosen, kindId: "claude" }, () => "new-press")).toBe("new-press");
	});
});

describe("emptyOfferMessage", () => {
	/** 기다리면 되는 것과 노트북에 가서 할 일이 있는 것은 다른 상태다. */
	it("아직 안 보낸 것과 정말로 없는 것을 가른다", () => {
		const waiting = emptyOfferMessage(offer({ published: false }));
		const none = emptyOfferMessage(offer({ published: true }));

		expect(waiting).toBeTruthy();
		expect(none).toBeTruthy();
		expect(waiting).not.toBe(none);
	});

	it("자리가 있으면 아무 말도 하지 않는다", () => {
		expect(emptyOfferMessage(READY)).toBeUndefined();
	});
});

describe("newActionId / retryKeepsActionId / actionIdFor", () => {
	it("누를 때마다 다른 이름을 짓는다", () => {
		expect(newActionId()).not.toBe(newActionId());
	});

	it("모른다고 한 답에는 같은 이름을 지킨다", () => {
		expect(retryKeepsActionId("screen_silent")).toBe(true);
		expect(retryKeepsActionId("screen_unreachable")).toBe(true);
		expect(retryKeepsActionId("still_starting")).toBe(true);
	});

	it("안 떴다고 한 답에는 새 이름을 짓는다", () => {
		expect(retryKeepsActionId("target_missing")).toBe(false);
		expect(retryKeepsActionId("failed")).toBe(false);
		expect(retryKeepsActionId(null)).toBe(false);
	});

	const press = { actionId: "press-1", targetId: "a", kindId: "claude", useWorktree: false, branch: "" };

	it("같은 것을 다시 누르면 같은 이름으로 보낸다", () => {
		expect(actionIdFor(press, press, () => "press-2")).toBe(
			"press-1",
		);
	});

	/**
	 * 이름은 그 선택에 대해 지어진 것이다. 지킨 이름으로 다른 폴더를 보내면
	 * 노트북은 아까 그 영수증에 붙이고, 사람은 방금 고른 것을 눌렀는데 처음 고른
	 * 것이 떠 있는 것을 본다.
	 */
	it("고른 것이 달라지면 새 이름을 짓는다", () => {
		expect(actionIdFor(press, { ...press, targetId: "b" }, () => "press-2")).toBe(
			"press-2",
		);
		expect(actionIdFor(press, { ...press, kindId: "codex" }, () => "press-2")).toBe(
			"press-2",
		);
	});

	it("새로 고른 폴더에는 새 누름 이름을 쓴다", () => {
		const press = {
			actionId: "press-1",
			targetId: "a",
			kindId: "claude",
			folderPath: "/Users/me/old",
			useWorktree: false,
			branch: "",
		};

		expect(
			actionIdFor(press, { ...press, folderPath: "/Users/me/new" }, () => "press-2"),
		).toBe("press-2");
	});

	it("keeps an identical effective branch and ignores the unused branch without a worktree", () => {
		const worktreePress = { ...press, useWorktree: true, branch: "agent/first" };
		expect(actionIdFor(worktreePress, { ...worktreePress, branch: " agent/first " })).toBe("press-1");
		expect(actionIdFor(press, { ...press, branch: "agent/unused" })).toBe("press-1");
	});
});
