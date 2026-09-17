export const files: Record<string, string> = {
	"files.transfer.fileTooLarge": "'{name}' supera el límite de transferencia de 50 MB",
	"files.transfer.duplicateName": "Ya existe un archivo con el mismo nombre: {name}",
	"files.transfer.totalTooLarge": "El tamaño total de los archivos no puede superar los 50 MB",
	"files.transfer.infoUnreadable": "No se pudo leer la información del archivo",
	"files.transfer.prepareInvalid": "El resultado de preparación de archivos no es válido",
	"files.transfer.tooManyFiles": "Puede transferir hasta 5 archivos a la vez",
	"files.transfer.remoteUpdateRequired":
		"Actualiza Hmux en el servidor conectado para pegar archivos en esta sesión.",
	"files.transfer.sessionChanged":
		"La sesión o la conexión SSH cambió durante la carga. Vuelve a pegar el archivo.",
	"files.transfer.sshRouteUnsupported":
		"Las opciones de este comando SSH no se pueden reutilizar de forma segura para pegar archivos. Abre el destino mediante la conexión SSH de Dure.",
};
