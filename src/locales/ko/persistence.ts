export const persistence: Record<string, string> = {
	"persistence.recovery.failed": "저장 데이터 복구 실패: {error}",
	"persistence.recovery.corruptBackupKept": "저장 데이터가 손상되어 {name}:corrupt-backup에 보관했습니다.",
	"persistence.recovery.hydrationFailed": "저장 데이터를 불러오지 못해 이번 실행 중의 변경 사항은 저장하지 않습니다. 저장 데이터는 그대로 두었고 {name}:hydration-failed-backup에 사본을 보관했습니다. ({error})",
	"persistence.windowClose.failedCloseAgain": "최신 창 상태를 저장하지 못했습니다. 그래도 종료하려면 창을 다시 닫으세요.",
	"persistence.guard.emptyOverNonEmpty": "차단됨: 채워진 상태를 빈 상태로 덮어쓰기를 거부합니다",
};
