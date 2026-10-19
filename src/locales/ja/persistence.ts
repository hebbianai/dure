export const persistence: Record<string, string> = {
	"persistence.recovery.failed": "保存データの復旧に失敗しました: {error}",
	"persistence.recovery.corruptBackupKept": "保存データが破損していたため、{name}:corrupt-backup に保管しました。",
	"persistence.recovery.hydrationFailed": "保存データを読み込めなかったため、このセッション中の変更は保存されません。保存データはそのまま残し、{name}:hydration-failed-backup にコピーを保管しました。({error})",
	"persistence.windowClose.failedCloseAgain": "最新のウィンドウ状態を保存できませんでした。それでも終了するには、もう一度ウィンドウを閉じてください。",
};
