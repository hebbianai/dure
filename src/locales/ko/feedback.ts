export const feedback: Record<string, string> = {
	"feedback.command": "피드백 보내기",
	"feedback.dialog.title": "피드백 보내기",
	"feedback.dialog.description":
		"버그를 신고하거나, 아이디어를 공유하거나, 다른 이야기를 전해주세요. 아래에서 실제로 전송될 내용을 그대로 확인할 수 있습니다.",
	"feedback.dialog.notice.title": "포함되는 내용",
	"feedback.dialog.notice.withScreenshot":
		"작성한 메시지, 아래 여섯 가지 환경 값, 선택 입력한 연락처, 그리고 사용량 제한에만 쓰이는 설치별 임의 토큰이 전송됩니다. 이 항목들에는 터미널 내용, 코드, 자격 증명이 절대 포함되지 않습니다. 스크린샷은 다릅니다 — 터미널 출력까지 포함해 이 창이 보이던 그대로 전송됩니다. 썸네일을 클릭해 실제 크기로 확인하세요.",
	"feedback.dialog.notice.withoutScreenshot":
		"작성한 메시지, 아래 여섯 가지 환경 값, 선택 입력한 연락처, 그리고 사용량 제한에만 쓰이는 설치별 임의 토큰이 전송됩니다. 스크린샷은 첨부되지 않으므로 화면에 있던 내용은 전송되지 않습니다. 이 항목들에는 터미널 내용, 코드, 자격 증명이 절대 포함되지 않습니다.",
	"feedback.dialog.kindLabel": "무엇에 관한 내용인가요?",
	"feedback.dialog.kind.bug": "버그",
	"feedback.dialog.kind.idea": "아이디어",
	"feedback.dialog.kind.other": "기타",
	"feedback.dialog.bodyLabel": "무슨 일이 있었나요?",
	"feedback.dialog.bodyPlaceholder":
		"무슨 일이 있었는지, 무엇을 기대했는지, 어떻게 재현하는지 적어주세요.",
	"feedback.dialog.contactLabel": "연락처 (선택)",
	"feedback.dialog.contactPlaceholder": "회신 받을 이메일 주소",
	"feedback.dialog.screenshot.title": "스크린샷",
	"feedback.dialog.screenshot.expand": "실제 크기로 보기",
	"feedback.dialog.screenshot.collapse": "실제 크기 숨기기",
	"feedback.dialog.screenshot.fullAlt": "이 창의 스크린샷 (실제 크기)",
	"feedback.dialog.screenshot.included": "이 창의 스크린샷이 첨부됩니다.",
	"feedback.dialog.screenshot.removed": "스크린샷이 포함되지 않습니다.",
	"feedback.dialog.screenshot.permissionTitle": "화면 기록 권한이 필요합니다",
	"feedback.dialog.screenshot.permissionBody":
		"macOS 화면 기록 권한이 허용되지 않아 Dure가 스크린샷을 캡처하지 못했습니다. 시스템 설정 › 개인정보 보호 및 보안 › 화면 기록에서 Dure를 켠 뒤 이 대화상자를 다시 열거나, 스크린샷 없이 보고서를 보내세요.",
	"feedback.dialog.screenshot.captureFailed":
		"스크린샷을 캡처하지 못했습니다: {reason}",
	"feedback.dialog.environment.summary": "환경 정보",
	"feedback.dialog.environment.os": "OS",
	"feedback.dialog.environment.arch": "아키텍처",
	"feedback.dialog.environment.locale": "언어",
	"feedback.dialog.environment.window": "창 크기",
	"feedback.dialog.environment.app": "앱 빌드",
	"feedback.dialog.environment.channel": "채널",
	"feedback.dialog.previewLabel": "실제로 전송될 보고서 미리보기",
	"feedback.dialog.send": "보내기",
	"feedback.dialog.sent": "전송됨",
	"feedback.dialog.sending": "보내는 중…",
	"feedback.dialog.retry": "다시 시도",
	"feedback.dialog.copyReport": "보고서 복사",
	"feedback.dialog.copySuccess": "피드백 보고서를 복사했습니다.",
	"feedback.dialog.copyFailed": "피드백 보고서를 복사하지 못했습니다: {error}",
	"feedback.dialog.sentNotice": "전송됨 — 참조 번호 {reference}.",
	"feedback.dialog.error.rejected":
		"Dure가 이 보고서를 받아들이지 못했습니다: {message}",
	"feedback.dialog.error.rateLimited":
		"이 기기에서 최근 너무 많은 보고서를 보냈습니다. 잠시 후 다시 시도하세요.",
	"feedback.dialog.error.temporary":
		"피드백 서비스가 일시적으로 이용할 수 없습니다. 작성한 내용은 그대로 남아 있으니 잠시 후 다시 시도하세요.",
	"feedback.dialog.error.network":
		"피드백 서비스에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.",
	"feedback.dialog.error.attachmentTooLarge":
		"스크린샷 용량이 너무 커서 보낼 수 없습니다.",
	"feedback.dialog.sendWithoutScreenshot": "스크린샷 없이 보내기",
	"feedback.dialog.error.rateLimitedWait":
		"이 기기 또는 네트워크에서 보낸 요청이 많습니다. {seconds}초 뒤 재시도할 수 있습니다. 작성한 내용은 유지됩니다.",
	"feedback.dialog.error.rateLimitedReady":
		"이제 재시도할 수 있습니다. 작성한 내용은 유지됩니다.",
};
