export const persistenceEnglishTranslations: Record<string, string> = {
	"persistence.recovery.failed": "Failed to recover saved data: {error}",
	"persistence.recovery.corruptBackupKept": "Saved data was corrupted; a recovery copy was kept at {name}:corrupt-backup.",
	"persistence.recovery.hydrationFailed": "Saved data could not be loaded, so changes made in this session will not be saved. The saved data was left untouched, with a copy at {name}:hydration-failed-backup. ({error})",
	"persistence.windowClose.failedCloseAgain": "Couldn't save the latest window state. Close again to exit anyway.",
};
