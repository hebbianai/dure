import type { SpaceRow } from "@/components/spaces/useSpaces";
import type { Provider } from "@/types";

/** useSpaces 행(SpaceRow)의 렌더에 필요한 부분집합 — 필드를 재선언하지 않고
 *  원본에서 골라 정의가 한 곳에 남게 한다. */
export type SpaceRowView = Pick<
	SpaceRow,
	| "key"
	| "desktopId"
	| "desktopName"
	| "kind"
	| "title"
	| "detail"
	| "detailSource"
	| "cwd"
	| "projectId"
	| "projectName"
	| "relativePath"
	| "branch"
	| "hostId"
	| "hostLabel"
	| "hostBuild"
	| "provider"
	| "managedPromotion"
	| "displayState"
	| "hidden"
	| "unread"
	| "agentId"
	| "activityAt"
>;

export interface SpaceMenuHandlers {
	onViewDiff: (key: string) => void;
	onMoveToDesktop: (key: string, desktopId: string) => void;
	onMoveToNewDesktop: (key: string) => void;
	onRestart: (key: string) => void;
	onFork: (key: string, provider: Provider) => void;
	onPromoteManaged: (key: string) => void;
	onSwitchAccount: (key: string, accountId: string | null) => void;
	onKill: (key: string) => void;
}
