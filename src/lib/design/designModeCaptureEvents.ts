/**
 * 사용자 앱 창의 캡처 이벤트를 앱에 잇는다 (Design Mode B단계).
 *
 * Rust가 브리지에서 받은 페이로드를 메인 창으로 emit하고, 여기서 모양을 검증해
 * A단계와 **같은** 카드·전달 흐름에 얹는다.
 */
import {
	DESIGN_MODE_CAPTURE_EVENT,
	remoteCapturedElement,
	remoteCaptureIntent,
	remoteCaptureKind,
} from "@/lib/design/designModeBrowser";
import {
	acceptRemoteCapture,
	reportRemoteCaptureEnd,
} from "@/lib/design/designModeRuntime";

/** 구독을 시작한다. 반환된 함수로 해제한다. */
export function subscribeDesignModeCaptures(): () => void {
	let disposed = false;
	let unlisten: (() => void) | undefined;
	void import("@tauri-apps/api/event")
		.then(({ listen }) =>
			listen(DESIGN_MODE_CAPTURE_EVENT, (event) => {
				const payload = event.payload;
				const kind = remoteCaptureKind(payload);
				if (!kind) return;
				if (kind === "pick") {
					const captured = remoteCapturedElement(payload);
					// 모양이 깨진 페이로드는 버린다 — 반쪽 캡처는 무엇을 고칠지 알 수 없는
					// 요청이 되고, 신뢰할 수 없는 페이지가 만든 값이다.
					if (!captured) {
						reportRemoteCaptureEnd("error", "payload_shape");
						return;
					}
					const intent = remoteCaptureIntent(payload);
					// 복사는 즉시성이 요점이다 — 스크린샷(수백 ms + 권한)을 기다리지
					// 않고, 텍스트 프롬프트만 클립보드로 보낸다.
					if (intent === "copy") {
						acceptRemoteCapture(captured, "copy");
						return;
					}
					// 스크린샷은 있으면 좋은 것이다. 실패하면(권한 없음 등) 그대로 진행한다 —
					// 스크린샷 하나 때문에 캡처를 버리면 그 사용자에게는 기능이 사라진다.
					void import("@/lib/ipc")
						.then(({ designModeScreenshot }) =>
							designModeScreenshot(captured.rect),
						)
						.then((screenshotPath) =>
							acceptRemoteCapture({ ...captured, screenshotPath }),
						)
						.catch((error) => {
							// fail-open이 이유까지 삼키면 진단이 불가능하다 — 동작은 그대로
							// 두고 흔적만 남긴다.
							console.error(
								"[design mode] screenshot failed — capture continues",
								error,
							);
							acceptRemoteCapture(captured);
						});
					return;
				}
				const reason = (payload as { body?: { reason?: unknown } }).body
					?.reason;
				reportRemoteCaptureEnd(
					kind,
					typeof reason === "string" ? reason : undefined,
				);
			}),
		)
		.then((stop) => {
			if (disposed) stop();
			else unlisten = stop;
		})
		.catch((error) => {
			console.error("[design mode] capture event subscription failed", error);
		});
	return () => {
		disposed = true;
		unlisten?.();
	};
}
