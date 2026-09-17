// 사이드바(파일 트리·에이전트·SSH·Spaces 행)에서 패널 영역으로의 드롭 처리 —
// Workspace에서 추출(god-file). 페이로드 계약은 `dure:{json}` text/plain.
// 드롭 위치가 마땅치 않으면(그룹도 방향도 없음 — 빈 중앙/보이드) 그리드 맨
// 끝에 붙이는 대신 드롭 지점에 떠 있는 pane(shift+드래그 오버레이와 같은
// 형태)으로 연다 — 사용자 요청 2026-08-01.
//
// 제약(소유자 지시): 이 floating 폴백은 **사이드바 페이로드에만** 적용한다.
// 이미 떠 있는 pane을 그리드로 되돌리는 내부 드래그에는 floating 위치를
// 추천하면 안 된다 — floating pane은 전용 이동 바가 그 역할을 한다.
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { t } from "@/lib/i18n";
import { launchRecentSessionPane } from "@/lib/sessions/launch/recentSessionPaneLaunch";
import { managedConversationLaunchFailureMessage } from "@/lib/sessions/managed/managedConversationLaunch";
import {
	parseRecentSessionDragPayload,
	RECENT_SESSION_DRAG_TYPE,
} from "@/lib/sessions/recentSessionDrag";
import {
	movePanelsToDesktop,
	openAgentPanel,
	openLocalTerminalPanel,
	openSshTerminalPanel,
} from "@/lib/workspace/dock";
import { openFileViewer } from "@/lib/files/fileViewerPane";
import { dropPosition, type PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { planSpacesPaneDrop } from "@/lib/sidebar/spacesPaneDrop";
import {
	movePanelToDesktopDrop,
	movePanelWithinDesktopDrop,
} from "@/lib/workspace/pane/paneDropCoordinator";
import { handlePaneWindowDataDrop } from "@/lib/workspace/pane/paneWindowTransferRuntime";
import {
	readDurePanelDragData,
	stripDureDragPayloadPrefix,
} from "@/lib/platform/productDragPayload";
import { useStore } from "@/store";
import {
	GITHUB_ISSUE_DRAG_TYPE,
	parseGitHubIssueDrag,
} from "@/lib/github/githubIssueDrag";
import { openGitHubIssuePanel } from "@/lib/workspace/dock/openGitHubIssuePanel";

export interface SidebarDropEvent {
	nativeEvent: DragEvent;
	position: string;
	group?: unknown;
}

export function handleSidebarDrop(
	event: SidebarDropEvent,
	desktopId: string,
	container: HTMLElement | null,
): void {
	if (handlePaneWindowDataDrop(event, desktopId)) return;
	const dt = event.nativeEvent.dataTransfer;
	const raw = readDurePanelDragData(dt);
	const json = stripDureDragPayloadPrefix(raw);
	if (!json.startsWith("{")) return;
	let spec: {
		type: string;
		agentId?: string;
		hostId?: string;
		hostName?: string;
		path?: string;
		isDir?: boolean;
		source?: "local" | "ssh";
		items?: { panelId: string; fromDesktopId: string }[];
		provider?: unknown;
		conversationId?: unknown;
		executionLocation?: unknown;
		cwd?: unknown;
		workspaceRoot?: unknown;
		ownerAgentId?: unknown;
		sourceAgentId?: unknown;
	};
	try {
		spec = JSON.parse(json);
	} catch {
		return;
	}
	let pos: PanelPosition = dropPosition(event.group, event.position);
	if (!pos.direction && !pos.referenceGroup) {
		const box = container?.getBoundingClientRect();
		pos = {
			floating: {
				x: Math.max(0, event.nativeEvent.clientX - (box?.x ?? 0) - 40),
				y: Math.max(0, event.nativeEvent.clientY - (box?.y ?? 0) - 16),
			},
		};
	}
	if (spec.type === GITHUB_ISSUE_DRAG_TYPE) {
		const row = parseGitHubIssueDrag(spec, useStore.getState().projects);
		if (row) openGitHubIssuePanel(desktopId, row, pos);
	} else if (spec.type === "file" && spec.path) {
		if (spec.isDir) {
			// 원격 폴더를 로컬 터미널 cwd로 열면 거짓 — 로컬만 터미널로.
			if (spec.source === "ssh") return;
			openLocalTerminalPanel(desktopId, spec.path, pos);
		} else {
			openFileViewer(
				desktopId,
				{
					path: spec.path,
					source: spec.source ?? "local",
					...(spec.hostId ? { hostId: spec.hostId } : {}),
				},
				pos,
			);
		}
	} else if (spec.type === "terminal") {
		openLocalTerminalPanel(desktopId, undefined, pos);
	} else if (spec.type === "agent" && spec.agentId) {
		const agent = useStore.getState().agents.find((a) => a.id === spec.agentId);
		if (agent) openAgentPanel(desktopId, agent, pos);
	} else if (spec.type === "ssh" && spec.hostId) {
		openSshTerminalPanel(desktopId, spec.hostId, spec.hostName ?? "SSH", pos);
	} else if (spec.type === RECENT_SESSION_DRAG_TYPE) {
		const payload = parseRecentSessionDragPayload(spec);
		if (!payload) return;
		void launchRecentSessionPane(payload, {
			desktopId,
			position: pos,
		}).catch((error) =>
			messageDialog(managedConversationLaunchFailureMessage(error), {
				title: t("common.conversationResumeFailed"),
				kind: "error",
			}),
		);
	} else if (spec.type === "move-panels" && Array.isArray(spec.items)) {
		// Spaces의 한 pane도 일반 pane drag와 같은 실제 기준 그룹/방향을
		// 따른다. 다중 선택만 기존 bulk 이동(기본 배치)을 유지한다.
		const plan = planSpacesPaneDrop(spec.items, desktopId, pos);
		if (plan.kind === "reorder") {
			movePanelWithinDesktopDrop(plan.item, desktopId, plan.position);
		} else if (plan.kind === "exact-transfer") {
			void movePanelToDesktopDrop(plan.item, desktopId, plan.position);
		} else if (plan.kind === "bulk-transfer") {
			void movePanelsToDesktop(plan.items, desktopId);
		}
	}
}
