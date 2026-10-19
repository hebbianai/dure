export const persistence: Record<string, string> = {
	"persistence.recovery.failed": "Error al recuperar los datos guardados: {error}",
	"persistence.recovery.corruptBackupKept": "Los datos guardados estaban dañados; se conservó una copia en {name}:corrupt-backup.",
	"persistence.recovery.hydrationFailed": "No se pudieron cargar los datos guardados, así que los cambios de esta sesión no se guardarán. Los datos guardados no se modificaron y se conservó una copia en {name}:hydration-failed-backup. ({error})",
	"persistence.windowClose.failedCloseAgain": "No se pudo guardar el estado más reciente de la ventana. Vuelve a cerrarla para salir de todos modos.",
	"persistence.guard.emptyOverNonEmpty": "Bloqueado: se niega a sobrescribir el estado poblado con un estado vacío",
};
