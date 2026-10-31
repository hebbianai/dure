export const persistence: Record<string, string> = {
	"persistence.recovery.failed": "Falha ao recuperar os dados salvos: {error}",
	"persistence.recovery.corruptBackupKept": "Os dados salvos estavam corrompidos; uma cópia de recuperação foi mantida em {name}:corrupt-backup.",
	"persistence.recovery.hydrationFailed": "Não foi possível carregar os dados salvos, então as alterações desta sessão não serão salvas. Os dados salvos não foram alterados e uma cópia foi mantida em {name}:hydration-failed-backup. ({error})",
	"persistence.windowClose.failedCloseAgain": "Não foi possível salvar o estado mais recente da janela. Feche-a novamente para sair mesmo assim.",
	"persistence.guard.emptyOverNonEmpty": "Bloqueado: recusando sobrescrever o estado preenchido com um estado vazio",
};
