export const automations: Record<string, string> = {
	"automations.model": "Modelo",
	"automations.effort": "Esfuerzo de razonamiento",
	"automations.providerDefault": "Predeterminado del proveedor",
	"automations.title": "Automatizaciones",
	"automations.new": "Nueva automatización",
	"automations.intro": "Convierte tareas recurrentes en un flujo repetible.",
	"automations.runtime": "Entorno: {name}",
	"automations.empty": "Aún no hay automatizaciones",
	"automations.active": "Programada",
	"automations.paused": "Pausada",
	"automations.limited": "Se muestran hasta 128 elementos.",
	"automations.flow": "Flujo",
	"automations.trigger": "Disparador",
	"automations.agent": "Agente",
	"automations.result": "Resultado",
	"automations.retainedReport": "Informe guardado",
	"automations.flowScope":
		"Un agente programado con un informe por ejecución. Selecciona un paso para configurarlo.",
	"automations.expression": "Horario",
	"automations.cronHelp":
		"Cron de cinco campos: minuto, hora, día, mes, día semanal. Ejemplo: 0 9 * * 1-5.",
	"automations.timezone": "Zona horaria",
	"automations.activation": "Ejecuciones programadas",
	"automations.runtimeHelp":
		"El entorno debe estar activo a la hora programada. Pausar detiene futuros disparadores, no las ejecuciones en curso.",
	"automations.project": "Proyecto",
	"automations.noProjects":
		"Registra un proyecto en este entorno para crear una automatización.",
	"automations.chooseProject": "Elige un proyecto",
	"automations.provider": "Proveedor del agente",
	"automations.prompt": "Instrucciones",
	"automations.permissions": "Permisos",
	"automations.defaultPermissions": "Valores del proveedor",
	"automations.requireApprovals": "Solicitar aprobación",
	"automations.skipPermissions": "Omitir confirmaciones de permisos",
	"automations.worktreeHelp":
		"Cada ejecución usa un worktree de Git independiente y las credenciales configuradas del agente.",
	"automations.resultHelp":
		"Los informes se guardan con su ejecución original. Consúltalos en Ejecuciones. Iniciar un agente no significa terminar; recibir un informe no certifica el éxito.",
	"automations.runs": "Ejecuciones",
	"automations.recentRuns": "Ejecuciones recientes",
	"automations.noRuns": "Aún no hay ejecuciones",
	"automations.manual": "Manual",
	"automations.scheduled": "Programada",
	"automations.runRevision": "Versión de configuración {revision}",
	"automations.noReport": "Aún no se ha recibido un informe de esta ejecución.",
	"automations.workspace": "Espacio de trabajo",
	"automations.saveFirst": "Guarda la configuración antes de ejecutar.",
	"automations.name": "Nombre",
	"automations.pause": "Pausar programación",
	"automations.testRun": "Ejecutar",
	"automations.reportReceived": "Informe recibido",
	"automations.awaitingDecision": "Esperando decisión",
	"automations.startFailed": "No se pudo iniciar",
	"automations.queued": "En cola",
	"automations.awaitingReport": "Iniciada · esperando informe",
	"automations.invalidResponse":
		"El entorno devolvió una respuesta de automatización no válida.",
	"automations.requestFailed":
		"No se pudo conectar con el entorno de automatización.",
	"automations.conflict":
		"Esta automatización cambió en otro lugar. Cierra el editor y actualiza la lista para cargar la última versión.",
	"automations.retryHelp":
		"El resultado no está confirmado. Reintentar envía la misma solicitud sin duplicarla.",
	"automations.closeUncertain":
		"¿Cerrar con una solicitud sin confirmar? Aún podría completarse.",
	"automations.discardQuestion": "¿Descartar los cambios sin guardar?",
	"automations.graph.projectLookupFailed":
		"No se pueden consultar los proyectos. Introduce un directorio en los pasos Command.",
	"automations.graph.editor": "Editor",
	"automations.graph.draft": "Borrador",
	"automations.graph.pause": "Pausar automatización",
	"automations.graph.active": "Activo",
	"automations.graph.saveDraft": "Guardar borrador",
	"automations.graph.activate": "Activar versión",
	"automations.graph.draftVersion": "Borrador · versión activa {version}",
	"automations.graph.version": "Versión {version}",
	"automations.graph.stepCount": "Pasos: {count}",
	"automations.graph.manual": "Manual",
	"automations.graph.schedule": "Programación",
	"automations.graph.canvas": "Lienzo del flujo",
	"automations.graph.addStep": "Añadir paso",
	"automations.graph.addStepHelp":
		"Selecciona un paso y añade otro para conectarlos. Asigna las salidas en los ajustes.",
	"automations.graph.emptyCanvas":
		"Añade un comando o agente, o empieza con la revisión diaria.",
	"automations.graph.selectStep": "Selecciona un paso para ver sus ajustes.",
	"automations.graph.selectToConfigure": "Selecciona para configurar",
	"automations.graph.needsSetup": "Requiere configuración",
	"automations.graph.stepSettings": "Ajustes del paso",
	"automations.graph.stepName": "Nombre del paso",
	"automations.graph.advanced": "Ajustes avanzados",
	"automations.graph.runAfter": "Ejecutar después de",
	"automations.graph.addConnection": "Añadir dependencia",
	"automations.graph.mappedConnection":
		"Esta conexión aporta una entrada asignada. Cambia su origen para quitarla.",
	"automations.graph.removeConnection": "Quitar conexión",
	"automations.graph.deleteStep": "Quitar paso",
	"automations.graph.deleteConfirm": "¿Quitar este paso?",
	"automations.graph.closeEditor": "Cerrar editor",
	"automations.graph.inputSource": "Origen de {field}",
	"automations.graph.literal": "Introducir un valor",
	"automations.graph.missingSource": "Referencia de salida ausente",
	"automations.graph.schemaOnly":
		"Solo se muestra el campo. Los valores reales aparecen tras ejecutar.",
	"automations.graph.directoryHelp":
		"Elige un proyecto o una carpeta absoluta en este entorno.",
	"automations.graph.scriptHelp":
		"Se ejecuta con /bin/sh. Los datos asignados se envían por la entrada estándar.",
	"automations.graph.chooseProvider": "Elegir proveedor",
	"automations.graph.zoomIn": "Acercar",
	"automations.graph.zoomOut": "Alejar",
	"automations.graph.fitView": "Ajustar flujo",
	"automations.graph.keyboardHelp":
		"Intro selecciona un paso. Las flechas lo mueven. Cambia conexiones en sus ajustes.",
	"automations.graph.connectionHelp":
		"Las conexiones indican dependencias. Edítalas en los ajustes del paso.",
	"automations.graph.nodeMoved": "Paso movido a {x}, {y}.",
	"automations.graph.connectionPoint": "Punto de conexión",
	"automations.graph.stepResult": "Resultado del paso",
	"automations.graph.inputs": "Entradas",
	"automations.graph.outputs": "Salidas",
	"automations.graph.noRuns": "Aún no hay ejecuciones",
	"automations.graph.notStarted": "Este paso no ha comenzado.",
	"automations.graph.waitingOutput": "Esperando la salida de este paso.",
	"automations.graph.fromStep": "De {name} · {field}",
	"automations.graph.failedHelp":
		"Paso fallido: {code}. Los pasos posteriores no se ejecutaron.",
	"automations.graph.uncertainHelp":
		"Resultado desconocido: {code}. Comprueba los efectos antes de otra ejecución.",
	"automations.graph.activeHelp":
		"Las ejecuciones manuales usan el borrador guardado. Las programadas usan la versión activa.",
	"automations.graph.draftHelp":
		"Guarda un borrador para ejecutarlo una vez. Activa una versión para habilitar su programación.",
	"automations.graph.dailyReview": "Revisión diaria",
	"automations.graph.collectChanges": "Recopilar cambios recientes",
	"automations.graph.reviewChanges": "Revisar cambios",
	"automations.graph.reviewPrompt":
		"Revisa los cambios de las últimas 24 horas. Inspecciona el código relevante e informa de riesgos concretos, pruebas y comprobaciones sugeridas. No fusiones ni despliegues cambios.",
	"automations.graph.actions.agent": "Agente",
	"automations.graph.actions.command": "Comando",
	"automations.graph.states.pending": "Sin iniciar",
	"automations.graph.states.started": "En ejecución",
	"automations.graph.states.running": "En ejecución",
	"automations.graph.states.completed": "Completado",
	"automations.graph.states.failed": "Fallido",
	"automations.graph.states.uncertain": "Resultado desconocido",
	"automations.graph.fields.script": "Comando de shell",
	"automations.graph.fields.directory": "Directorio de trabajo",
	"automations.graph.fields.projectId": "Proyecto",
	"automations.graph.fields.providerId": "Proveedor del agente",
	"automations.graph.fields.prompt": "Instrucciones",
	"automations.graph.fields.input": "Contexto de entrada",
	"automations.graph.fields.stdin": "Entrada estándar",
	"automations.graph.fields.stdout": "Salida estándar",
	"automations.graph.fields.stderr": "Salida de error",
	"automations.graph.fields.exitCode": "Código de salida",
	"automations.graph.fields.resultMarkdown": "Informe del agente",
	"automations.graph.fields.timeoutSeconds": "Tiempo límite en segundos",
	"automations.graph.fields.executionProfile": "Perfil de ejecución (JSON)",
	"automations.graph.fields.permissionMode": "Permisos",
	"automations.graph.issues.missingInput":
		"Selecciona o introduce esta entrada.",
	"automations.graph.issues.missingOutput":
		"La salida de origen falta o es opcional. Elige otro campo.",
	"automations.graph.issues.typeMismatch":
		"El tipo de esta salida no es compatible.",
	"automations.graph.issues.literalRequired":
		"Introduce un valor fijo para este ajuste.",
	"automations.graph.issues.cycle":
		"Las conexiones forman un ciclo. Quita una dependencia.",
	"automations.graph.issues.unsupportedAction":
		"Esta versión de la acción no está disponible aquí.",
	"automations.graph.issues.locationRequired":
		"Elige un proyecto o un directorio absoluto existente.",
	"automations.graph.issues.timeoutInvalid":
		"Usa 1–300 segundos para comandos o 1–86400 para agentes.",
	"automations.graph.issues.projectUnavailable":
		"Este proyecto no está registrado en el entorno seleccionado.",
	"automations.graph.issues.requiredValue":
		"Introduce texto no vacío dentro del límite de la acción.",
	"automations.graph.issues.empty": "Añade un paso para empezar.",
	"automations.graph.issues.revisionConflict":
		"El flujo cambió en otro lugar. Ábrelo de nuevo para cargar la última versión.",
	"automations.graph.issues.invalid": "Revisa este ajuste ({code}).",
};
