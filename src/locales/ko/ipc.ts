export const ipc: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"실행 호스트에서 provider 실행 파일을 찾지 못했습니다. 해당 호스트에 선택한 provider를 설치하거나 PATH를 수정한 뒤 이 요청을 다시 시도하세요.",
	"ipc.dureRun.providerNotExecutable":
		"provider 실행 파일을 실행할 수 없습니다. 실행 호스트의 파일 경로와 실행 권한을 확인한 뒤 이 요청을 다시 시도하세요.",
	"ipc.dureRun.providerLookupFailed":
		"실행 호스트에서 provider 실행 파일을 확인하지 못했습니다. 경로와 접근 권한을 확인한 뒤 이 요청을 다시 시도하세요.",
	"ipc.dureRun.providerPathMissing":
		"실행 호스트의 PATH를 사용할 수 없습니다. PATH를 복원한 뒤 이 요청을 다시 시도하세요.",
	"ipc.browser.invalidResponse":
		"브라우저 상태를 읽지 못했습니다. pane을 새로고침하세요.",
	"ipc.browser.connectionChanged":
		"브라우저 연결이 변경되었습니다. 다시 연결한 뒤 브라우저를 선택하세요.",
	"ipc.browser.unavailable":
		"이 브라우저를 더 이상 사용할 수 없습니다. 다시 연결한 뒤 브라우저를 선택하세요.",
	"ipc.browser.developmentRequired":
		"Pro Browser를 사용하려면 브라우저를 지원하는 개발용 백엔드가 필요합니다. 선택한 백엔드를 업데이트한 뒤 다시 연결하세요.",
	"ipc.browser.runtimeRequired":
		"선택한 백엔드에 브라우저 런타임이 설치되어 있지 않습니다. 해당 백엔드에 런타임을 설치한 뒤 브라우저를 생성하세요.",
	"ipc.browser.requestFailed":
		"브라우저 요청이 완료되지 않았습니다. 다시 시도하기 전에 상태를 확인하세요.",
	"ipc.agentConversation.invalidResponse": "에이전트 대화 응답이 올바르지 않습니다.",
	"ipc.agentConversation.requestFailed": "에이전트 대화 요청에 실패했습니다.",
	"ipc.dureBackend.generationChanged": "Dure 백엔드 세대가 변경되었습니다. 같은 요청으로 다시 시도하세요.",
	"ipc.dureCoordinator.bindingMismatch": "코디네이터 바인딩 응답이 현재 pane과 일치하지 않습니다.",
	"ipc.dureDelegation.invalidResponse": "Dure 백엔드가 올바르지 않은 위임 응답을 반환했습니다.",
	"ipc.dureDelegation.receiptMismatch": "Dure 백엔드가 요청과 일치하지 않는 위임 영수증을 반환했습니다.",
	"ipc.dureDelegation.requestFailed": "Dure 위임 요청에 실패했습니다.",
	"ipc.dureDispatch.inspectionReceiptMismatch": "Dure Dispatch inspection receipt가 exact Session과 일치하지 않습니다.",
	"ipc.dureDispatch.rebindReceiptMismatch": "Dure Dispatch rebind receipt가 journal-selected Sessions와 일치하지 않습니다.",
	"ipc.dureOrchestration.apiResponseMismatch": "Dure orchestration API 응답이 요청과 일치하지 않습니다.",
	"ipc.dureOrchestration.authorityGenerationChanged": "Dure orchestration authority 세대가 변경되어 Inbox를 다시 동기화합니다.",
	"ipc.dureOrchestration.invalidResponse": "Dure orchestration 응답 형식이 올바르지 않습니다.",
	"ipc.dureOrchestration.receiptContractMismatch": "Dure orchestration receipt가 계약과 일치하지 않습니다.",
	"ipc.dureOrchestration.requestFailed": "Dure orchestration 요청에 실패했습니다.",
	"ipc.dureOrchestration.responseMismatch": "Dure orchestration 응답이 요청과 일치하지 않습니다.",
	"ipc.dureRun.invalidResponse": "Dure 백엔드가 올바르지 않은 Run 응답을 반환했습니다.",
	"ipc.dureRun.stageFailed": "에이전트를 시작하지 못했습니다 — {stage} 단계 실패 ({code}). 다시 시도해 주세요.",
	"ipc.dureRun.promptUncertain": "에이전트는 시작됐지만 프롬프트를 받았다는 확인이 없습니다 ({code}). 다시 보내기 전에 그 터미널을 확인하세요.",
	"ipc.dureRun.receiptMismatch": "Dure 백엔드가 요청과 일치하지 않는 Run 영수증을 반환했습니다.",
	"ipc.dureRun.requestFailed": "Dure 백엔드 Run 요청에 실패했습니다.",
};
