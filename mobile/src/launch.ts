/**
 * 폰에서 에이전트 하나를 띄우기까지의 판단. Figma `dure-UI` 3172:81560.
 *
 * 그리는 쪽은 [`launchView`]. 여기에는 화면이 없어도 답할 수 있는 것만 둔다 —
 * 무엇을 고를 수 있는지, 왜 못 고르는지, 지금 누를 수 있는지.
 *
 * # 왜 스페이스와 폴더를 따로 고르나
 *
 * 자리는 스페이스 하나와 폴더 하나의 짝이고, 노트북은 그 짝마다 id 를 하나씩
 * 준다. 그 짝을 한 목록으로 펼치면 폴더 스무 개짜리 노트북에서 스페이스 수만큼
 * 곱해진 줄이 서는데, 사람이 고르는 것은 언제나 둘이지 그 곱이 아니다. 그래서
 * 화면은 둘로 나눠 묻고, 고른 둘을 다시 그 짝의 id 로 되돌린다.
 *
 * # 왜 못 고르는 것을 목록에서 빼지 않나
 *
 * 노트북이 원격 폴더와 설치되지 않은 에이전트를 **실어서** 보내는 이유와 같다.
 * 없는 것과 지금은 안 되는 것은 다른 사실이고, 빼 버리면 자기가 등록한 폴더를
 * 찾는 사람은 왜 없는지 알 길이 없다.
 */

import type { LaunchOffer, LaunchOfferKind, LaunchOfferTarget } from "./ipc";

/** 화면이 들고 있는 선택. */
export interface LaunchForm {
	readonly spaceLabel?: string;
	readonly targetId?: string;
	readonly kindId?: string;
	/** 새 worktree 에서 시작할 것인가. 디자인의 기본값은 켬이다. */
	readonly useWorktree: boolean;
	/** 그 worktree 의 브랜치. 비어 있으면 노트북이 짓는다. */
	readonly branch: string;
	/** A local path selected outside the published folder offer. */
	readonly folderPath?: string;
	readonly folderLabel?: string;
	readonly folderHint?: string;
}

/** 저장소가 쓰는 브랜치 접두사. 목업의 `worktree/` 가 아닌 이유는 노트북의
 *  `defaultBranchName` 이 `agent/` 를 쓰기 때문이다 — 다른 접두사를 폰에서만
 *  쓰면 같은 저장소의 브랜치가 두 갈래로 갈린다. */
export const BRANCH_PREFIX = "agent/";

export function emptyForm(): LaunchForm {
	return { useWorktree: true, branch: BRANCH_PREFIX };
}

/** 노트북이 준 순서 그대로의 스페이스 이름들. 사람이 사이드바에서 외운 순서다. */
export function spacesOf(offer: LaunchOffer): string[] {
	const seen: string[] = [];
	for (const target of offer.targets) {
		if (!seen.includes(target.space_label)) seen.push(target.space_label);
	}
	return seen;
}

/** 그 스페이스 안의 폴더들. */
export function foldersOf(
	offer: LaunchOffer,
	spaceLabel: string | undefined,
): LaunchOfferTarget[] {
	return offer.targets.filter((target) => target.space_label === spaceLabel);
}

export function targetOf(
	offer: LaunchOffer,
	form: Pick<LaunchForm, "targetId" | "folderPath">,
): LaunchOfferTarget | undefined {
	const target = offer.targets.find((target) => target.id === form.targetId);
	if (!target || !form.folderPath) return target;
	// The browser chooses a local path; the offered target only anchors its space.
	return {
		...target,
		startable: true,
		worktree_supported: true,
		provider_installation: "reported",
	};
}

export function canSelectKind(
	kind: LaunchOfferKind,
	target: LaunchOfferTarget | undefined,
): boolean {
	return target?.provider_installation === "check_on_start" || kind.installed;
}

/** Initially choose the first space, its first startable folder, and an eligible
 * provider for that target. Later target changes preserve the user's provider. */
export function preselect(offer: LaunchOffer): Partial<LaunchForm> {
	const spaceLabel = spacesOf(offer)[0];
	const folder = foldersOf(offer, spaceLabel).find(
		(target) => target.startable,
	);
	const kind = offer.kinds.find((one) => canSelectKind(one, folder));
	return {
		...(spaceLabel ? { spaceLabel } : {}),
		...(folder ? { targetId: folder.id } : {}),
		...(kind ? { kindId: kind.id } : {}),
	};
}

/** 스페이스를 바꾸면 폴더 선택은 따라오지 못한다 — 그 폴더는 다른 스페이스 것이다. */
export function selectSpace(
	offer: LaunchOffer,
	form: LaunchForm,
	spaceLabel: string,
): LaunchForm {
	const folder = foldersOf(offer, spaceLabel).find(
		(target) => target.startable,
	);
	return {
		...form,
		spaceLabel,
		targetId: folder?.id,
		folderPath: undefined,
		folderLabel: undefined,
		folderHint: undefined,
	};
}

/**
 * 지금 시작을 누를 수 있는가.
 *
 * 고른 것들이 **아직 목록에 있고** 다 쓸 수 있을 때만이다. 목록이 갱신되면서
 * 고른 것이 사라질 수 있고, 그때 버튼이 살아 있으면 눌러도 거절만 돌아온다.
 * worktree 를 켰으면 브랜치가 접두사만 남아 있어도 안 된다 — `agent/` 하나는
 * 브랜치 이름이 아니다.
 */
export function canStart(offer: LaunchOffer, form: LaunchForm): boolean {
	const target = targetOf(offer, form);
	const kind = offer.kinds.find((one) => one.id === form.kindId);
	if (!target?.startable || !kind || !canSelectKind(kind, target)) return false;
	if (!form.useWorktree) return true;
	if (target.worktree_supported === false) return false;
	const branch = form.branch.trim();
	return branch.length > 0 && branch !== BRANCH_PREFIX && !branch.endsWith("/");
}

/**
 * 노트북이 아무 자리도 내놓지 않았을 때 화면이 쓸 문장.
 *
 * 아직 안 보낸 것과 정말로 없는 것을 가른다. 전자는 기다리면 되고, 후자는
 * 노트북에 가서 폴더를 등록해야 한다 — 사람이 할 일이 다르다.
 */
export function emptyOfferMessage(offer: LaunchOffer): string | undefined {
	if (offer.targets.length > 0) return undefined;
	return offer.published
		? "이 컴퓨터에 등록된 폴더가 없습니다. 노트북에서 폴더를 열면 여기 나옵니다"
		: "노트북 화면이 아직 목록을 보내지 않았습니다. 잠시 뒤 다시 열어 보세요";
}

/**
 * 이 누름의 이름.
 *
 * 시작을 누르는 그 순간에 한 번 짓고, 재시도는 같은 값을 다시 보낸다. 재시도할
 * 때마다 새로 지으면 노트북에게는 사람이 여러 번 누른 것과 같아진다.
 */
export function newActionId(): string {
	const random =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `press-${random}`;
}

/**
 * 이 답을 보고 나서 다시 누르는 것은 **같은 누름**인가.
 *
 * 노트북이 "안 떴다" 고 말한 경우는 다시 누르는 것이 새 누름이다 — 아무것도 안
 * 생겼으니 이름을 새로 지어야 한다. "모르겠다" 는 다르다: 요청은 이미 닿아서
 * 에이전트가 뜨고 있는 중일 수 있고, 그때 이름을 새로 지으면 노트북은 그것을
 * 두 번째 누름으로 읽고 하나 더 띄운다.
 */
const UNKNOWN_OUTCOME_CODES = new Set([
	"screen_silent",
	"screen_unreachable",
	"still_starting",
]);

export function retryKeepsActionId(code: string | null): boolean {
	return code !== null && UNKNOWN_OUTCOME_CODES.has(code);
}

/** 어느 선택에 대해 지어진 이름인가. */
export interface LaunchPress extends LaunchForm {
	readonly actionId: string;
	readonly targetId: string;
	readonly kindId: string;
}

/**
 * 다시 보낼 때 쓸 누름의 이름.
 *
 * 이름은 **그 선택에 대해** 지어진 것이다. 답을 못 받아 이름을 지킨 채로 사람이
 * 다른 폴더나 다른 에이전트를 고르면, 같은 이름으로 보낸 요청은 노트북에서 아까
 * 그 영수증에 붙는다 — 사람은 방금 고른 것을 눌렀는데 처음 고른 것이 떠 있게
 * 된다. 선택이 달라지면 이름도 새로 짓는다.
 */
export function actionIdFor(
	press: LaunchPress | undefined,
	form: LaunchForm,
	mint: () => string = newActionId,
): string {
	return press &&
		press.targetId === form.targetId &&
		press.kindId === form.kindId &&
		press.folderPath === form.folderPath &&
		press.useWorktree === form.useWorktree &&
		(!form.useWorktree || press.branch.trim() === form.branch.trim())
		? press.actionId
		: mint();
}

/** 화면이 칩에 그릴 아이콘을 고르는 근거. 세션 줄과 같은 규칙을 쓴다. */
export function kindGlyphKind(kind: LaunchOfferKind): "claude" | "dot" {
	return kind.id === "claude" ? "claude" : "dot";
}
