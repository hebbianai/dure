export const persistence: Record<string, string> = {
	"persistence.recovery.failed": "恢复保存的数据失败：{error}",
	"persistence.recovery.corruptBackupKept": "保存的数据已损坏，已保留一份恢复副本至 {name}:corrupt-backup。",
	"persistence.recovery.hydrationFailed": "无法加载保存的数据，因此本次会话中的更改不会被保存。保存的数据保持不变，并已在 {name}:hydration-failed-backup 保留一份副本。({error})",
	"persistence.windowClose.failedCloseAgain": "无法保存最新的窗口状态。若仍要退出，请再次关闭窗口。",
	"persistence.guard.emptyOverNonEmpty": "已阻止：拒绝用空状态覆盖已填充状态",
};
