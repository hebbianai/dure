// Pinpoint 캡처 카드의 마운트 지점. App 루트에 한 번 둔다(Toaster와 같은 자리).
// 픽커는 React 밖에서 켜지므로 구독으로 받는다.
//
// dev 전용이 아니다: 우리 UI를 짚는 것(⌥⇧D)은 dev 빌드에만 뜻이 있지만, 내 앱을
// 열어 짚는 것(B단계)은 모든 사용자용이고 그 캡처도 이 카드로 돌아온다. 예전에는
// App이 이 레이어를 dev에서만 마운트해, 프로덕션에서는 창이 떠도 캡처가 갈 곳이
// 없었다 — 설계 문서(design-mode.md)가 B단계를 "프로덕션 포함"으로 적어 둔 것과
// 어긋났다. 주소 입력 다이얼로그와 ⌥⇧B는 PinpointButton이 소유한다.
import { useEffect, useState } from "react";
import { DesignModeCaptureCard } from "@/components/design/DesignModeCaptureCard";
import { subscribeDesignModeCaptures } from "@/lib/design/designModeCaptureEvents";
import {
	copyPendingCapture,
	dismissDesignModeCapture,
	type PendingCapture,
	sendPendingCapture,
	subscribeDesignModeCapture,
} from "@/lib/design/designModeRuntime";

export function DesignModeLayer() {
	const [pending, setPending] = useState<PendingCapture | null>(null);
	useEffect(() => subscribeDesignModeCapture(setPending), []);
	// 사용자 앱 창(B단계)에서 오는 캡처도 같은 카드로 받는다.
	useEffect(() => subscribeDesignModeCaptures(), []);

	if (!pending) return null;
	return (
		<DesignModeCaptureCard
			label={pending.captured.label}
			choice={pending.choice}
			imageSrc={
				pending.attachment
					? `data:image/png;base64,${pending.attachment.dataB64}`
					: undefined
			}
			attachmentError={pending.attachmentError}
			busy={pending.sending}
			onSend={(agentId, preset) => void sendPendingCapture(agentId, preset)}
			onCopy={() => void copyPendingCapture()}
			onDismiss={dismissDesignModeCapture}
		/>
	);
}
