export const automations: Record<string, string> = {
	"automations.model": "Modèle",
	"automations.effort": "Effort de raisonnement",
	"automations.providerDefault": "Valeur par défaut du fournisseur",
	"automations.title": "Automatisations",
	"automations.new": "Nouvelle automatisation",
	"automations.intro":
		"Transformez les tâches récurrentes en flux réutilisables.",
	"automations.runtime": "Environnement : {name}",
	"automations.empty": "Aucune automatisation",
	"automations.active": "Planifiée",
	"automations.paused": "En pause",
	"automations.limited": "Jusqu’à 128 éléments affichés.",
	"automations.flow": "Flux",
	"automations.trigger": "Déclencheur",
	"automations.agent": "Agent",
	"automations.result": "Résultat",
	"automations.retainedReport": "Rapport conservé",
	"automations.flowScope":
		"Un agent planifié et un rapport par exécution. Sélectionnez une étape pour la configurer.",
	"automations.expression": "Planification",
	"automations.cronHelp":
		"Cron à cinq champs : minute, heure, jour, mois, jour de semaine. Exemple : 0 9 * * 1-5.",
	"automations.timezone": "Fuseau horaire",
	"automations.activation": "Exécutions planifiées",
	"automations.runtimeHelp":
		"L’environnement doit fonctionner à l’heure prévue. La pause empêche les prochains déclenchements sans arrêter les exécutions en cours.",
	"automations.project": "Projet",
	"automations.noProjects":
		"Enregistrez un projet dans cet environnement pour créer une automatisation.",
	"automations.chooseProject": "Choisir un projet",
	"automations.provider": "Fournisseur de l’agent",
	"automations.prompt": "Instructions",
	"automations.permissions": "Autorisations",
	"automations.defaultPermissions": "Réglages du fournisseur",
	"automations.requireApprovals": "Demander une autorisation",
	"automations.skipPermissions": "Ignorer les demandes d’autorisation",
	"automations.worktreeHelp":
		"Chaque exécution utilise un worktree Git distinct et les identifiants configurés de l’agent.",
	"automations.resultHelp":
		"Les rapports sont conservés avec leur exécution d’origine. Consultez-les dans Exécutions. Un agent démarré attend encore son rapport ; sa réception ne certifie pas la réussite.",
	"automations.runs": "Exécutions",
	"automations.recentRuns": "Exécutions récentes",
	"automations.noRuns": "Aucune exécution",
	"automations.manual": "Manuelle",
	"automations.scheduled": "Planifiée",
	"automations.runRevision": "Version de configuration {revision}",
	"automations.noReport": "Aucun rapport reçu pour cette exécution.",
	"automations.workspace": "Espace de travail",
	"automations.saveFirst": "Enregistrez la configuration avant de l’exécuter.",
	"automations.name": "Nom",
	"automations.pause": "Mettre en pause",
	"automations.testRun": "Exécuter",
	"automations.reportReceived": "Rapport reçu",
	"automations.awaitingDecision": "En attente de décision",
	"automations.startFailed": "Échec du démarrage",
	"automations.queued": "En file d’attente",
	"automations.awaitingReport": "Démarrée · rapport attendu",
	"automations.invalidResponse":
		"L’environnement a renvoyé une réponse d’automatisation invalide.",
	"automations.requestFailed":
		"Impossible de joindre l’environnement d’automatisation.",
	"automations.conflict":
		"Cette automatisation a été modifiée ailleurs. Fermez l’éditeur et actualisez la liste.",
	"automations.retryHelp":
		"Le résultat reste inconnu. Réessayer renvoie la même demande sans doublon.",
	"automations.closeUncertain":
		"Fermer avec une demande non confirmée ? Elle peut encore aboutir.",
	"automations.discardQuestion":
		"Abandonner les modifications non enregistrées ?",
	"automations.graph.projectLookupFailed":
		"La liste des projets est indisponible. Indiquez un dossier pour les étapes Command.",
	"automations.graph.editor": "Éditeur",
	"automations.graph.draft": "Brouillon",
	"automations.graph.pause": "Suspendre l’automatisation",
	"automations.graph.active": "Actif",
	"automations.graph.saveDraft": "Enregistrer le brouillon",
	"automations.graph.activate": "Activer la version",
	"automations.graph.draftVersion": "Brouillon · version active {version}",
	"automations.graph.version": "Version {version}",
	"automations.graph.stepCount": "Étapes : {count}",
	"automations.graph.manual": "Manuel",
	"automations.graph.schedule": "Planification",
	"automations.graph.canvas": "Canevas du workflow",
	"automations.graph.addStep": "Ajouter une étape",
	"automations.graph.addStepHelp":
		"Sélectionnez une étape, puis ajoutez-en une autre pour les relier. Associez les sorties dans les réglages.",
	"automations.graph.emptyCanvas":
		"Ajoutez une commande ou un agent, ou commencez par la revue quotidienne.",
	"automations.graph.selectStep":
		"Sélectionnez une étape pour voir ses réglages.",
	"automations.graph.selectToConfigure": "Sélectionner pour configurer",
	"automations.graph.needsSetup": "Configuration requise",
	"automations.graph.stepSettings": "Réglages de l’étape",
	"automations.graph.stepName": "Nom de l’étape",
	"automations.graph.advanced": "Réglages avancés",
	"automations.graph.runAfter": "Exécuter après",
	"automations.graph.addConnection": "Ajouter une dépendance",
	"automations.graph.mappedConnection":
		"Cette connexion fournit une entrée associée. Changez sa source pour la supprimer.",
	"automations.graph.removeConnection": "Supprimer la connexion",
	"automations.graph.deleteStep": "Supprimer l’étape",
	"automations.graph.deleteConfirm": "Supprimer cette étape ?",
	"automations.graph.closeEditor": "Fermer l’éditeur",
	"automations.graph.inputSource": "Source de {field}",
	"automations.graph.literal": "Saisir une valeur",
	"automations.graph.missingSource": "Référence de sortie manquante",
	"automations.graph.schemaOnly":
		"Le champ de sortie est affiché. Les valeurs réelles apparaissent après exécution.",
	"automations.graph.directoryHelp":
		"Choisissez un projet ou saisissez un chemin absolu sur cet environnement.",
	"automations.graph.scriptHelp":
		"Exécution avec /bin/sh. Les données associées passent par l’entrée standard.",
	"automations.graph.chooseProvider": "Choisir un fournisseur",
	"automations.graph.zoomIn": "Agrandir",
	"automations.graph.zoomOut": "Réduire",
	"automations.graph.fitView": "Ajuster le workflow",
	"automations.graph.keyboardHelp":
		"Entrée sélectionne une étape. Les flèches la déplacent. Modifiez les connexions dans ses réglages.",
	"automations.graph.connectionHelp":
		"Les connexions indiquent les dépendances. Modifiez-les dans les réglages de l’étape.",
	"automations.graph.nodeMoved": "Étape déplacée vers {x}, {y}.",
	"automations.graph.connectionPoint": "Point de connexion",
	"automations.graph.stepResult": "Résultat de l’étape",
	"automations.graph.inputs": "Entrées",
	"automations.graph.outputs": "Sorties",
	"automations.graph.noRuns": "Aucune exécution",
	"automations.graph.notStarted": "Cette étape n’a pas commencé.",
	"automations.graph.waitingOutput": "En attente de la sortie de cette étape.",
	"automations.graph.fromStep": "Depuis {name} · {field}",
	"automations.graph.failedHelp":
		"Échec de l’étape : {code}. Les étapes suivantes n’ont pas été exécutées.",
	"automations.graph.uncertainHelp":
		"Résultat inconnu : {code}. Vérifiez les effets avant une nouvelle exécution.",
	"automations.graph.activeHelp":
		"Les exécutions manuelles utilisent le brouillon enregistré. Les exécutions planifiées utilisent la version active.",
	"automations.graph.draftHelp":
		"Enregistrez un brouillon pour l’exécuter une fois. Activez une version pour lancer sa planification.",
	"automations.graph.dailyReview": "Revue quotidienne",
	"automations.graph.collectChanges": "Recueillir les changements récents",
	"automations.graph.reviewChanges": "Examiner les changements",
	"automations.graph.reviewPrompt":
		"Examinez les changements fournis des dernières 24 heures. Inspectez le code pertinent et signalez les risques concrets, les preuves et les vérifications suggérées. Ne fusionnez ni ne déployez de changements.",
	"automations.graph.actions.agent": "Agent",
	"automations.graph.actions.command": "Commande",
	"automations.graph.states.pending": "Non démarré",
	"automations.graph.states.started": "En cours",
	"automations.graph.states.running": "En cours",
	"automations.graph.states.completed": "Terminé",
	"automations.graph.states.failed": "Échec",
	"automations.graph.states.uncertain": "Résultat inconnu",
	"automations.graph.fields.script": "Commande shell",
	"automations.graph.fields.directory": "Répertoire de travail",
	"automations.graph.fields.projectId": "Projet",
	"automations.graph.fields.providerId": "Fournisseur de l’agent",
	"automations.graph.fields.prompt": "Instructions",
	"automations.graph.fields.input": "Contexte d’entrée",
	"automations.graph.fields.stdin": "Entrée standard",
	"automations.graph.fields.stdout": "Sortie standard",
	"automations.graph.fields.stderr": "Sortie d’erreur",
	"automations.graph.fields.exitCode": "Code de sortie",
	"automations.graph.fields.resultMarkdown": "Rapport de l’agent",
	"automations.graph.fields.timeoutSeconds": "Délai en secondes",
	"automations.graph.fields.executionProfile": "Profil d’exécution (JSON)",
	"automations.graph.fields.permissionMode": "Autorisations",
	"automations.graph.issues.missingInput":
		"Choisissez ou saisissez cette entrée.",
	"automations.graph.issues.missingOutput":
		"La sortie source est absente ou facultative. Choisissez un autre champ.",
	"automations.graph.issues.typeMismatch":
		"Le type de cette sortie est incompatible.",
	"automations.graph.issues.literalRequired":
		"Saisissez une valeur fixe pour ce réglage.",
	"automations.graph.issues.cycle":
		"Ces connexions forment un cycle. Supprimez une dépendance.",
	"automations.graph.issues.unsupportedAction":
		"Cette version de l’action n’est pas disponible sur cet environnement.",
	"automations.graph.issues.locationRequired":
		"Choisissez un projet ou un répertoire absolu existant.",
	"automations.graph.issues.timeoutInvalid":
		"Utilisez 1–300 secondes pour une commande, ou 1–86400 pour un agent.",
	"automations.graph.issues.projectUnavailable":
		"Ce projet n’est pas enregistré sur l’environnement choisi.",
	"automations.graph.issues.requiredValue":
		"Saisissez un texte non vide respectant la limite de l’action.",
	"automations.graph.issues.empty": "Ajoutez une étape pour commencer.",
	"automations.graph.issues.revisionConflict":
		"Le workflow a été modifié ailleurs. Rouvrez-le pour charger la dernière version.",
	"automations.graph.issues.invalid": "Vérifiez ce réglage ({code}).",
};
