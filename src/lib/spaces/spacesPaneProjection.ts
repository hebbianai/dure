import { shallow } from "zustand/shallow";
import { terminalPaneHostId } from "@/lib/terminal/paneHostIdentity";
import { reuseStableRows } from "@/lib/ui/stableRows";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import {
	panelsFromLayout,
	type SerializedPanelRef,
} from "@/lib/workspace/layout/layoutLifecycle";

type LivePane = {
	readonly id: string;
	readonly component?: string;
	readonly params: Record<string, unknown>;
	readonly isVisible: boolean;
};

export type SpacePane = {
	readonly key: string;
	readonly desktopId: string;
	readonly sessionId: string;
	readonly kind: "agent" | "term" | "ssh";
	readonly agentId?: string;
	/** 숨긴 pane — 세션은 살아 있고 표면만 걷힌 상태(원래 자리 표시용) */
	readonly hidden?: true;
	readonly hostId?: string;
	readonly cwd?: string;
	/** hmux binding pane의 검증된 세션 정체성 — 메타데이터(host 빌드 등) 조회용 */
	readonly hmuxIdentity?: {
		readonly sessionId: string;
		readonly workspaceId: string;
		readonly runtime:
			| "hmux_session_v1"
			| "hmux_standalone_v1"
			| "hmux_managed_v1";
	};
};

const HMUX_RUNTIMES = [
	"hmux_session_v1",
	"hmux_standalone_v1",
	"hmux_managed_v1",
] as const;

function isHmuxRuntime(
	value: unknown,
): value is NonNullable<SpacePane["hmuxIdentity"]>["runtime"] {
	return (
		typeof value === "string" &&
		(HMUX_RUNTIMES as readonly string[]).includes(value)
	);
}

type RawParams = {
	readonly sessionId?: string;
	readonly hostId?: string;
	readonly cwd?: string;
	readonly hmuxIdentity?: SpacePane["hmuxIdentity"];
};

function readRawParams(value: unknown): RawParams {
	if (!value || typeof value !== "object") return {};
	return {
		...("sessionId" in value && typeof value.sessionId === "string"
			? { sessionId: value.sessionId }
			: {}),
		// The Host that owns the pane, by the one rule every pane consumer
		// shares: a remote binding names it, a local binding carries none, and
		// the top-level id survives only for pre-binding SSH layouts. A `term:`
		// pane has no other host field, so this is what tells a remote
		// standalone shell apart from a local one.
		...(() => {
			const hostId = terminalPaneHostId(
				value as Readonly<Record<string, unknown>>,
			);
			return hostId ? { hostId } : {};
		})(),
		...("cwd" in value && typeof value.cwd === "string"
			? { cwd: value.cwd }
			: {}),
		...(() => {
			// 검증된 (workspaceId, sessionId) 쌍이 있는 hmux binding만 정체성으로 인정
			if (
				!("binding" in value) ||
				!value.binding ||
				typeof value.binding !== "object"
			) {
				return {};
			}
			const binding = value.binding as {
				runtime?: unknown;
				sessionId?: unknown;
				workspaceId?: unknown;
			};
			const runtime = binding.runtime;
			if (
				!isHmuxRuntime(runtime) ||
				typeof binding.sessionId !== "string" ||
				typeof binding.workspaceId !== "string"
			) {
				return {};
			}
			return {
				hmuxIdentity: {
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					runtime,
				},
			};
		})(),
	};
}

function classifyPanel(
	desktopId: string,
	panel: SerializedPanelRef,
	hidden = false,
): SpacePane | null {
	const key = panel.id;
	const agentId = agentIdFromPane(panel);
	if (agentId) {
		return {
			key,
			desktopId,
			sessionId: "",
			kind: "agent",
			agentId,
			...(hidden ? { hidden: true } : {}),
		};
	}
	const params = readRawParams(panel.params);
	if (panel.component === "terminal" && params.sessionId) {
		return {
			key,
			desktopId,
			sessionId: params.sessionId,
			kind: "term",
			// Set only from a remote binding; a local shell carries none.
			hostId: params.hostId,
			cwd: params.cwd,
			hmuxIdentity: params.hmuxIdentity,
		};
	}
	if (panel.component === "ssh" && params.sessionId) {
		return {
			key,
			desktopId,
			sessionId: params.sessionId,
			kind: "ssh",
			hostId: params.hostId,
			cwd: params.cwd,
			// 터미널 pane 과 같은 값을 싣는다. 원격 hmux 세션에 묶인 SSH pane 이
			// 그 신원을 들고 있고, 폰은 그 값으로만 같은 세션을 알아본다.
			//
			// 오래 빠져 있었는데 읽는 쪽이 없어서 표가 나지 않았다. 지금도 관측된
			// 고장을 고치는 것은 아니다 — 위 `term:` 갈래와 같은 값을 같은 이유로
			// 싣는 것뿐이고, 한쪽만 나르면 다음에 읽는 사람이 그 차이를 의도로
			// 읽는다.
			hmuxIdentity: params.hmuxIdentity,
		};
	}
	return null;
}

function readOpenPanels(
	layouts: Record<string, unknown>,
	activeSpaceId: string,
	desktopOrder: readonly string[],
	livePanels: readonly LivePane[] | undefined,
): readonly SpacePane[] {
	const spaces: SpacePane[] = [];
	const seen = new Set<string>();
	const add = (
		desktopId: string,
		panel: SerializedPanelRef,
		hidden = false,
	) => {
		if (seen.has(panel.id)) return;
		const space = classifyPanel(desktopId, panel, hidden);
		if (!space) return;
		spaces.push(space);
		seen.add(panel.id);
	};
	if (livePanels) {
		for (const panel of livePanels) {
			add(activeSpaceId, panel, !panel.isVisible);
		}
	}
	for (const desktopId of desktopOrder) {
		if (desktopId === activeSpaceId && livePanels) continue;
		for (const panel of panelsFromLayout(layouts[desktopId])) {
			add(desktopId, panel);
		}
	}
	return spaces;
}

/** Share one interpreted pane list between row identity and presentation. The
 * inputs remain owned by the layout store and the mounted Dockview. */
export function createSpacesPaneProjection() {
	let previous: readonly SpacePane[] | undefined;
	let sourceLayouts: Record<string, unknown> | undefined;
	let sourceDesktopId: string | undefined;
	let sourceOrder: readonly string[] | undefined;
	let sourceLive: readonly LivePane[] | undefined;
	return (
		layouts: Record<string, unknown>,
		activeDesktopId: string,
		desktopOrder: readonly string[],
		livePanels: readonly LivePane[] | undefined,
	): readonly SpacePane[] => {
		const live = livePanels && reuseStableRows(sourceLive, livePanels);
		if (
			previous &&
			layouts === sourceLayouts &&
			activeDesktopId === sourceDesktopId &&
			desktopOrder === sourceOrder &&
			live === sourceLive
		)
			return previous;
		const panes = readOpenPanels(layouts, activeDesktopId, desktopOrder, live);
		const comparable = panes.map((pane, index) => {
			const before = previous?.[index];
			if (
				!before ||
				!pane.hmuxIdentity ||
				!shallow(before.hmuxIdentity, pane.hmuxIdentity)
			)
				return pane;
			return { ...pane, hmuxIdentity: before.hmuxIdentity };
		});
		previous = reuseStableRows(previous, comparable);
		sourceLayouts = layouts;
		sourceDesktopId = activeDesktopId;
		sourceOrder = desktopOrder;
		sourceLive = live;
		return previous;
	};
}
