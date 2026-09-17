/**
 * Design Mode 토글의 앱 측 배선 (A단계 — 대상은 Dure 자기 UI).
 *
 * 캡처·픽커는 앱 비의존 모듈이고(B단계에서 사용자 앱 창에 주입), 이 파일이 그것을
 * 우리 앱에 붙인다. 캡처 뒤에는 대상 선택 카드를 띄운다 — 구독 패턴은 toast.ts와
 * 같다(전역 상태 + 구독자, React 밖에서 켜지므로).
 */

import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { lastInputAgentId } from "@/lib/agents/agentInputRecency";
import type { CapturedElement } from "@/lib/design/designModeCapture";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";
import {
	type PickerHandle,
	startDesignModePicker,
} from "@/lib/design/designModePicker";
import {
	formatCapturedElement,
	formatRedesignMockupPrompt,
} from "@/lib/design/designModePrompt";
import {
	type AgentTargetChoice,
	chooseAgentTarget,
} from "@/lib/design/designModeTarget";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { t } from "@/lib/i18n";
import { createBroadcast } from "@/lib/state/broadcast";
import { showToast } from "@/lib/toast";
import { useStore } from "@/store";

export interface PendingCapture {
	captured: CapturedElement;
	text: string;
	choice: AgentTargetChoice;
	attachment?: DroppedFilePayload;
	attachmentError?: boolean;
	sending?: boolean;
}

type Listener = (pending: PendingCapture | null) => void;

const changes = createBroadcast<PendingCapture | null>();
let pending: PendingCapture | null = null;
let active: PickerHandle | null = null;

function publish(next: PendingCapture | null): void {
	pending = next;
	changes.publish(next);
}

export function subscribeDesignModeCapture(listener: Listener): () => void {
	const unsubscribe = changes.subscribe(listener);
	listener(pending);
	return unsubscribe;
}

export function dismissDesignModeCapture(): void {
	publish(null);
}

/** 켜져 있으면 끄고, 꺼져 있으면 켠다. 픽커 핸들이 곧 상태다 — 토글이 상태를
 *  따로 들면 두 곳이 어긋난다. */
export function toggleDesignMode(): void {
	if (active) {
		active.stop();
		active = null;
		showToast(t("design.pinpoint.off"));
		return;
	}
	publish(null);
	active = startDesignModePicker({
		onPick: (captured, _element, intent) => {
			active = null;
			acceptCapturedElement(captured, intent);
		},
		onCancel: () => {
			active = null;
			showToast(t("design.pinpoint.off"));
		},
	});
	showToast(t("design.pinpoint.instructions"), 2600);
}

/** 보낼 수 있는 에이전트 후보. 이름 순이 아니라 store 순서를 유지한다 —
 *  사이드바에서 보이는 순서와 같아야 사용자가 고를 때 헷갈리지 않는다. */
function agentCandidates() {
	return useStore.getState().agents.map((agent) => ({
		id: agent.id,
		name: agentDisplayName(agent),
		provider: agent.provider,
	}));
}

/** Shared fan-out for a capture whose menu already chose the action — copy
 *  finishes immediately without the card; send opens the target-choice card.
 *  Menu path and remote right-click path must stay one flow. */
function acceptCapturedElement(
	captured: CapturedElement,
	intent: "send" | "copy",
	attachment: Pick<PendingCapture, "attachment" | "attachmentError"> = {},
): void {
	const text = formatCapturedElement(captured);
	if (intent === "copy") {
		void navigator.clipboard
			.writeText(text)
			.then(() => showToast(t("design.clipboard.copied")))
			.catch(() => showToast(t("design.clipboard.writeFailed")));
		return;
	}
	publish({
		captured,
		text,
		attachment: attachment.attachment,
		attachmentError: attachment.attachmentError,
		choice: chooseAgentTarget({
			candidates: agentCandidates(),
			lastInputAgentId: lastInputAgentId(),
		}),
	});
}

export async function sendPendingCapture(
	agentId: string,
	preset: "raw" | "redesign-mockup" = "raw",
): Promise<void> {
	const current = pending;
	if (!current || current.sending) return;
	const sending = { ...current, sending: true };
	publish(sending);
	try {
		const { screenshotPath, ...element } = current.captured;
		const details = formatCapturedElement(element);
		const text =
			preset === "redesign-mockup"
				? formatRedesignMockupPrompt(details)
				: details;
		await deliverCaptureToAgent(
			agentId,
			text,
			current.attachment
				? [{ kind: "bytes", file: current.attachment }]
				: screenshotPath
					? [{ kind: "local_file", path: screenshotPath }]
					: [],
		);
		if (pending === sending) publish(null);
		// 제출은 사용자가 한다 — 그 사실을 다시 알린다.
		showToast(t("common.typedIntoPromptPressEnter"), 3000);
	} catch (error) {
		if (pending === sending) publish({ ...sending, sending: false });
		// 실패를 성공으로 보이게 두지 않는다. 카드는 남겨 사용자가 복사로 넘어갈 수
		// 있게 한다.
		showToast(
			t("common.typeFailed", {
				error: error instanceof Error ? error.message : String(error),
			}),
			3200,
		);
	}
}

/** 사용자 앱 창(B단계)에서 온 캡처를 같은 카드·전달 흐름에 얹는다. A단계와 같은
 *  경로를 쓰는 것이 요점이다 — 표면만 다르고 판정·포맷·전달은 하나다. */
export function acceptRemoteCapture(
	captured: CapturedElement,
	intent: "send" | "copy" = "send",
	attachment: Pick<PendingCapture, "attachment" | "attachmentError"> = {},
): void {
	acceptCapturedElement(captured, intent, attachment);
}

/** 원격 창의 취소·오류. 조용히 넘기지 않는다 — 사용자는 클릭이 왜 안 먹는지
 *  알아야 한다. navigation은 페이지가 넘어가 픽커가 초기화된 경우다. */
export function reportRemoteCaptureEnd(
	kind: "cancel" | "error",
	reason?: string,
): void {
	if (kind === "error") {
		showToast(
			t("design.capture.failed", { reason: reason ?? "unknown" }),
			3000,
		);
		return;
	}
	if (reason === "navigation") {
		showToast(t("design.pinpoint.offAfterNavigation"), 2600);
		return;
	}
	showToast(t("design.pinpoint.off"));
}

export async function copyPendingCapture(): Promise<void> {
	const current = pending;
	if (!current) return;
	try {
		await navigator.clipboard.writeText(current.text);
		if (pending === current) publish(null);
		showToast(t("design.clipboard.copied"));
	} catch {
		showToast(t("design.clipboard.writeFailed"));
	}
}
