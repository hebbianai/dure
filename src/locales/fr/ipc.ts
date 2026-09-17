export const ipc: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"L’exécutable du fournisseur est introuvable sur l’hôte d’exécution. Installez-y le fournisseur sélectionné ou corrigez PATH, puis réessayez cette requête.",
	"ipc.dureRun.providerNotExecutable":
		"L’exécutable du fournisseur ne peut pas s’exécuter. Vérifiez son chemin et ses droits d’exécution sur l’hôte, puis réessayez cette requête.",
	"ipc.dureRun.providerLookupFailed":
		"Dure n’a pas pu inspecter l’exécutable du fournisseur sur l’hôte d’exécution. Vérifiez le chemin et les droits d’accès, puis réessayez cette requête.",
	"ipc.dureRun.providerPathMissing":
		"PATH est indisponible sur l’hôte d’exécution. Restaurez-le, puis réessayez cette requête.",
	"ipc.browser.invalidResponse":
		"Impossible de lire l’état du navigateur. Actualisez le pane.",
	"ipc.browser.connectionChanged":
		"La connexion du navigateur a changé. Reconnectez-vous pour choisir un navigateur.",
	"ipc.browser.unavailable":
		"Ce navigateur n’est plus disponible. Reconnectez-vous pour choisir un navigateur.",
	"ipc.browser.developmentRequired":
		"Pro Browser nécessite un backend de développement compatible. Mettez à jour le backend sélectionné, puis reconnectez-vous.",
	"ipc.browser.runtimeRequired":
		"Le moteur du navigateur est absent du backend sélectionné. Installez-le sur ce backend avant de créer un navigateur.",
	"ipc.browser.requestFailed":
		"La requête du navigateur n’a pas abouti. Vérifiez son état avant de réessayer.",
	"ipc.agentConversation.invalidResponse": "La réponse de conversation de l’agent est invalide.",
	"ipc.agentConversation.requestFailed": "La requête de conversation de l’agent a échoué.",
	"ipc.agentConversation.deliveryUnconfirmed": "La transmission du message n’a pas pu être confirmée. Vérifiez la conversation avant de le renvoyer.",
	"ipc.dureBackend.generationChanged": "La génération du backend Dure a changé. Réessayez avec la même requête.",
	"ipc.dureCoordinator.bindingMismatch": "La réponse de liaison du coordinateur ne correspond pas au volet actuel.",
	"ipc.dureDelegation.invalidResponse": "Le backend Dure a renvoyé une réponse de délégation invalide.",
	"ipc.dureDelegation.receiptMismatch": "Le backend Dure a renvoyé un reçu de délégation qui ne correspond pas à la requête.",
	"ipc.dureDelegation.requestFailed": "La demande de délégation Dure a échoué.",
	"ipc.dureDispatch.inspectionReceiptMismatch": "Le reçu d’inspection Dispatch de Dure ne correspond pas à la session exacte.",
	"ipc.dureDispatch.rebindReceiptMismatch": "Le reçu de reliaison Dispatch de Dure ne correspond pas aux sessions sélectionnées par le journal.",
	"ipc.dureOrchestration.apiResponseMismatch": "La réponse de l’API d’orchestration Dure ne correspond pas à la requête.",
	"ipc.dureOrchestration.authorityGenerationChanged": "La génération de l’autorité d’orchestration Dure a changé ; resynchronisation de la boîte de réception.",
	"ipc.dureOrchestration.invalidResponse": "Le format de la réponse d’orchestration Dure est invalide.",
	"ipc.dureOrchestration.receiptContractMismatch": "Le reçu d’orchestration Dure ne correspond pas au contrat.",
	"ipc.dureOrchestration.requestFailed": "La requête d’orchestration Dure a échoué.",
	"ipc.dureOrchestration.responseMismatch": "La réponse d’orchestration Dure ne correspond pas à la requête.",
	"ipc.dureRun.invalidResponse": "Le backend Dure a renvoyé une réponse Run invalide.",
	"ipc.dureRun.stageFailed": "Impossible de démarrer l’agent — l’étape {stage} a échoué ({code}). Réessayez.",
	"ipc.dureRun.promptUncertain": "L’agent a démarré mais n’a jamais confirmé l’invite ({code}). Vérifiez son terminal avant de renvoyer la demande.",
	"ipc.dureRun.receiptMismatch": "Le backend Dure a renvoyé un reçu de Run qui ne correspond pas à la requête.",
	"ipc.dureRun.requestFailed": "La requête Run au backend Dure a échoué.",
};
