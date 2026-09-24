export const feedback: Record<string, string> = {
	"feedback.command": "Enviar comentarios",
	"feedback.dialog.title": "Enviar comentarios",
	"feedback.dialog.description":
		"Reporta un error, comparte una idea o cuéntanos otra cosa. Revisa abajo exactamente lo que se enviará.",
	"feedback.dialog.notice.title": "Qué se incluye",
	"feedback.dialog.notice.withScreenshot":
		"Tu mensaje, los seis valores de entorno de abajo, un contacto opcional y un token aleatorio por instalación que solo sirve para limitar la frecuencia. Esos campos nunca incluyen contenido de la terminal, código ni credenciales. La captura sí: envía esta ventana tal como se veía, incluida la salida de la terminal. Haz clic en la miniatura para verla a tamaño completo.",
	"feedback.dialog.notice.withoutScreenshot":
		"Tu mensaje, los seis valores de entorno de abajo, un contacto opcional y un token aleatorio por instalación que solo sirve para limitar la frecuencia. No se adjunta ninguna captura, así que no se envía nada de lo que hubiera en pantalla. Esos campos nunca incluyen contenido de la terminal, código ni credenciales.",
	"feedback.dialog.kindLabel": "¿De qué se trata esto?",
	"feedback.dialog.kind.bug": "Error",
	"feedback.dialog.kind.idea": "Idea",
	"feedback.dialog.kind.other": "Otro",
	"feedback.dialog.bodyLabel": "¿Qué pasó?",
	"feedback.dialog.bodyPlaceholder":
		"Describe qué pasó, qué esperabas y cómo reproducirlo.",
	"feedback.dialog.contactLabel": "Contacto (opcional)",
	"feedback.dialog.contactPlaceholder": "Correo electrónico, para responderte",
	"feedback.dialog.screenshot.title": "Captura de pantalla",
	"feedback.dialog.screenshot.expand": "Ver a tamaño completo",
	"feedback.dialog.screenshot.collapse": "Ocultar el tamaño completo",
	"feedback.dialog.screenshot.fullAlt":
		"Captura de esta ventana a tamaño completo",
	"feedback.dialog.screenshot.included":
		"Se adjunta una captura de esta ventana.",
	"feedback.dialog.screenshot.removed": "No se incluye la captura de pantalla.",
	"feedback.dialog.screenshot.permissionTitle":
		"Se necesita el permiso de grabación de pantalla",
	"feedback.dialog.screenshot.permissionBody":
		"Dure no pudo capturar una captura de pantalla porque el permiso de Grabación de pantalla de macOS no está concedido. Abre Ajustes del sistema › Privacidad y seguridad › Grabación de pantalla, activa Dure y vuelve a abrir este cuadro de diálogo, o envía tu reporte sin una captura.",
	"feedback.dialog.screenshot.captureFailed":
		"No se pudo capturar la pantalla: {reason}",
	"feedback.dialog.environment.summary": "Entorno",
	"feedback.dialog.environment.os": "SO",
	"feedback.dialog.environment.arch": "Arquitectura",
	"feedback.dialog.environment.locale": "Idioma",
	"feedback.dialog.environment.window": "Ventana",
	"feedback.dialog.environment.app": "Compilación de la app",
	"feedback.dialog.environment.channel": "Canal",
	"feedback.dialog.previewLabel": "Vista previa exacta del reporte",
	"feedback.dialog.send": "Enviar",
	"feedback.dialog.sent": "Enviado",
	"feedback.dialog.sending": "Enviando…",
	"feedback.dialog.retry": "Reintentar",
	"feedback.dialog.copyReport": "Copiar reporte",
	"feedback.dialog.copySuccess": "Reporte de comentarios copiado.",
	"feedback.dialog.copyFailed":
		"No se pudo copiar el reporte de comentarios: {error}",
	"feedback.dialog.sentNotice": "Enviado — referencia {reference}.",
	"feedback.dialog.error.rejected":
		"Dure no pudo aceptar este reporte: {message}",
	"feedback.dialog.error.rateLimited":
		"Demasiados reportes de este dispositivo recientemente. Vuelve a intentarlo en un momento.",
	"feedback.dialog.error.temporary":
		"El servicio de comentarios no está disponible temporalmente. Tu reporte sigue aquí — vuelve a intentarlo en breve.",
	"feedback.dialog.error.network":
		"No se pudo conectar con el servicio de comentarios. Revisa tu conexión e inténtalo de nuevo.",
	"feedback.dialog.error.attachmentTooLarge":
		"La captura de pantalla es demasiado grande para enviarla.",
	"feedback.dialog.sendWithoutScreenshot": "Enviar sin la captura de pantalla",
	"feedback.dialog.error.rateLimitedWait":
		"Demasiados informes desde este dispositivo o red. Puedes reintentar en {seconds} segundos. Tu informe sigue aquí.",
	"feedback.dialog.error.rateLimitedReady":
		"Ya puedes reintentar. Tu informe sigue aquí.",
};
