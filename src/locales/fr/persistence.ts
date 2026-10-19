export const persistence: Record<string, string> = {
	"persistence.recovery.failed": "Échec de la récupération des données enregistrées : {error}",
	"persistence.recovery.corruptBackupKept": "Les données enregistrées étaient corrompues ; une copie de récupération a été conservée sous {name}:corrupt-backup.",
	"persistence.recovery.hydrationFailed": "Les données enregistrées n’ont pas pu être chargées : les modifications de cette session ne seront pas enregistrées. Les données enregistrées sont intactes et une copie a été conservée sous {name}:hydration-failed-backup. ({error})",
	"persistence.windowClose.failedCloseAgain": "Impossible d’enregistrer le dernier état de la fenêtre. Fermez-la à nouveau pour quitter quand même.",
};
