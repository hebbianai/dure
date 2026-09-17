export const ipc: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"No se encontró el ejecutable del proveedor en el host de ejecución. Instala allí el proveedor seleccionado o corrige PATH y vuelve a intentar esta solicitud.",
	"ipc.dureRun.providerNotExecutable":
		"El ejecutable del proveedor no se puede ejecutar. Comprueba su ruta y permisos de ejecución en el host y vuelve a intentar esta solicitud.",
	"ipc.dureRun.providerLookupFailed":
		"Dure no pudo inspeccionar el ejecutable del proveedor en el host de ejecución. Comprueba la ruta y los permisos de acceso y vuelve a intentar esta solicitud.",
	"ipc.dureRun.providerPathMissing":
		"PATH no está disponible en el host de ejecución. Restáuralo y vuelve a intentar esta solicitud.",
	"ipc.browser.invalidResponse":
		"No se pudo leer el estado del navegador. Actualiza el pane.",
	"ipc.browser.connectionChanged":
		"La conexión del navegador ha cambiado. Vuelve a conectarte para elegir un navegador.",
	"ipc.browser.unavailable":
		"Este navegador ya no está disponible. Vuelve a conectarte para elegir un navegador.",
	"ipc.browser.developmentRequired":
		"Pro Browser requiere un backend de desarrollo compatible. Actualiza el backend seleccionado y vuelve a conectarte.",
	"ipc.browser.runtimeRequired":
		"El entorno de ejecución del navegador no está instalado en el backend seleccionado. Instálalo allí antes de crear un navegador.",
	"ipc.browser.requestFailed":
		"La solicitud del navegador no terminó. Comprueba su estado antes de intentarlo de nuevo.",
	"ipc.agentConversation.invalidResponse": "La respuesta de conversación del agente no es válida.",
	"ipc.agentConversation.requestFailed": "La solicitud de conversación del agente falló.",
	"ipc.dureBackend.generationChanged": "La generación del backend de Dure cambió. Reintenta con la misma solicitud.",
	"ipc.dureCoordinator.bindingMismatch": "La respuesta del enlace del coordinador no coincide con el panel actual.",
	"ipc.dureDelegation.invalidResponse": "El backend de Dure devolvió una respuesta de delegación no válida.",
	"ipc.dureDelegation.receiptMismatch": "El backend de Dure devolvió un recibo de delegación que no coincide con la solicitud.",
	"ipc.dureDelegation.requestFailed": "La solicitud de delegación de Dure falló.",
	"ipc.dureDispatch.inspectionReceiptMismatch": "El recibo de inspección de Dispatch de Dure no coincide con la sesión exacta.",
	"ipc.dureDispatch.rebindReceiptMismatch": "El recibo de reenlace de Dispatch de Dure no coincide con las sesiones seleccionadas por el journal.",
	"ipc.dureOrchestration.apiResponseMismatch": "La respuesta de la API de orquestación de Dure no coincide con la solicitud.",
	"ipc.dureOrchestration.authorityGenerationChanged": "La generación de la autoridad de orquestación de Dure cambió; se vuelve a sincronizar la bandeja de entrada.",
	"ipc.dureOrchestration.invalidResponse": "El formato de la respuesta de orquestación de Dure no es válido.",
	"ipc.dureOrchestration.receiptContractMismatch": "El recibo de orquestación de Dure no coincide con el contrato.",
	"ipc.dureOrchestration.requestFailed": "La solicitud de orquestación de Dure falló.",
	"ipc.dureOrchestration.responseMismatch": "La respuesta de orquestación de Dure no coincide con la solicitud.",
	"ipc.dureRun.invalidResponse": "El backend de Dure devolvió una respuesta de Run no válida.",
	"ipc.dureRun.stageFailed": "No se pudo iniciar el agente: el paso {stage} falló ({code}). Inténtalo de nuevo.",
	"ipc.dureRun.promptUncertain": "El agente se inició, pero nunca confirmó el mensaje ({code}). Revisa su terminal antes de volver a enviarlo.",
	"ipc.dureRun.receiptMismatch": "El backend de Dure devolvió un recibo de Run que no coincide con la solicitud.",
	"ipc.dureRun.requestFailed": "La solicitud de Run al backend de Dure falló.",
};
