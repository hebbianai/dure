export const files: Record<string, string> = {
	"files.transfer.fileTooLarge": "'{name}' dépasse la limite de transfert de 50 Mo",
	"files.transfer.duplicateName": "Un fichier du même nom existe déjà : {name}",
	"files.transfer.totalTooLarge": "La taille totale des fichiers ne peut pas dépasser 50 Mo",
	"files.transfer.infoUnreadable": "Impossible de lire les informations du fichier",
	"files.transfer.prepareInvalid": "Le résultat de préparation des fichiers n'est pas valide",
	"files.transfer.tooManyFiles": "Vous pouvez transférer jusqu'à 5 fichiers à la fois",
	"files.transfer.remoteUpdateRequired":
		"Mettez à jour Hmux sur le serveur connecté pour coller des fichiers dans cette session.",
	"files.transfer.sessionChanged":
		"La session ou la connexion SSH a changé pendant le transfert. Collez à nouveau le fichier.",
	"files.transfer.sshRouteUnsupported":
		"Les options de cette commande SSH ne peuvent pas être réutilisées de façon sûre pour coller des fichiers. Ouvrez la destination via la connexion SSH de Dure.",
};
