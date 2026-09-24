export const feedback: Record<string, string> = {
	"feedback.command": "Envoyer un retour",
	"feedback.dialog.title": "Envoyer un retour",
	"feedback.dialog.description":
		"Signalez un bug, partagez une idée ou dites-nous autre chose. Vérifiez ci-dessous exactement ce qui sera envoyé.",
	"feedback.dialog.notice.title": "Ce qui est inclus",
	"feedback.dialog.notice.withScreenshot":
		"Votre message, les six valeurs d'environnement ci-dessous, un contact facultatif et un jeton aléatoire propre à cette installation, utilisé uniquement pour limiter la fréquence. Ces champs ne contiennent jamais le contenu du terminal, le code ni les identifiants. La capture, si : elle envoie cette fenêtre telle qu'elle était, sortie du terminal comprise. Cliquez sur la miniature pour la voir en taille réelle.",
	"feedback.dialog.notice.withoutScreenshot":
		"Votre message, les six valeurs d'environnement ci-dessous, un contact facultatif et un jeton aléatoire propre à cette installation, utilisé uniquement pour limiter la fréquence. Aucune capture n'est jointe : rien de ce qui était à l'écran n'est envoyé. Ces champs ne contiennent jamais le contenu du terminal, le code ni les identifiants.",
	"feedback.dialog.kindLabel": "De quoi s'agit-il ?",
	"feedback.dialog.kind.bug": "Bug",
	"feedback.dialog.kind.idea": "Idée",
	"feedback.dialog.kind.other": "Autre",
	"feedback.dialog.bodyLabel": "Que s'est-il passé ?",
	"feedback.dialog.bodyPlaceholder":
		"Décrivez ce qui s'est passé, ce à quoi vous vous attendiez, et comment le reproduire.",
	"feedback.dialog.contactLabel": "Contact (facultatif)",
	"feedback.dialog.contactPlaceholder": "E-mail, pour vous répondre",
	"feedback.dialog.screenshot.title": "Capture d'écran",
	"feedback.dialog.screenshot.expand": "Voir en taille réelle",
	"feedback.dialog.screenshot.collapse": "Masquer la taille réelle",
	"feedback.dialog.screenshot.fullAlt":
		"Capture de cette fenêtre en taille réelle",
	"feedback.dialog.screenshot.included":
		"Une capture de cette fenêtre est jointe.",
	"feedback.dialog.screenshot.removed": "Capture d'écran non incluse.",
	"feedback.dialog.screenshot.permissionTitle":
		"Autorisation d'enregistrement de l'écran requise",
	"feedback.dialog.screenshot.permissionBody":
		"Dure n'a pas pu capturer l'écran car l'autorisation macOS d'enregistrement de l'écran n'est pas accordée. Ouvrez Réglages Système › Confidentialité et sécurité › Enregistrement de l'écran, activez Dure, puis rouvrez cette boîte de dialogue — ou envoyez votre rapport sans capture.",
	"feedback.dialog.screenshot.captureFailed":
		"Impossible de capturer l'écran : {reason}",
	"feedback.dialog.environment.summary": "Environnement",
	"feedback.dialog.environment.os": "Système",
	"feedback.dialog.environment.arch": "Architecture",
	"feedback.dialog.environment.locale": "Langue",
	"feedback.dialog.environment.window": "Fenêtre",
	"feedback.dialog.environment.app": "Version de l'app",
	"feedback.dialog.environment.channel": "Canal",
	"feedback.dialog.previewLabel": "Aperçu exact du rapport",
	"feedback.dialog.send": "Envoyer",
	"feedback.dialog.sent": "Envoyé",
	"feedback.dialog.sending": "Envoi…",
	"feedback.dialog.retry": "Réessayer",
	"feedback.dialog.copyReport": "Copier le rapport",
	"feedback.dialog.copySuccess": "Rapport de retour copié.",
	"feedback.dialog.copyFailed":
		"Impossible de copier le rapport de retour : {error}",
	"feedback.dialog.sentNotice": "Envoyé — référence {reference}.",
	"feedback.dialog.error.rejected":
		"Dure n'a pas pu accepter ce rapport : {message}",
	"feedback.dialog.error.rateLimited":
		"Trop de rapports envoyés récemment depuis cet appareil. Réessayez dans un instant.",
	"feedback.dialog.error.temporary":
		"Le service de retours est temporairement indisponible. Votre rapport est toujours là — réessayez bientôt.",
	"feedback.dialog.error.network":
		"Impossible de joindre le service de retours. Vérifiez votre connexion et réessayez.",
	"feedback.dialog.error.attachmentTooLarge":
		"La capture d'écran est trop volumineuse pour être envoyée.",
	"feedback.dialog.sendWithoutScreenshot": "Envoyer sans la capture d'écran",
	"feedback.dialog.error.rateLimitedWait":
		"Trop de rapports depuis cet appareil ou ce réseau. Vous pourrez réessayer dans {seconds} secondes. Votre rapport est conservé.",
	"feedback.dialog.error.rateLimitedReady":
		"Vous pouvez réessayer maintenant. Votre rapport est conservé.",
};
