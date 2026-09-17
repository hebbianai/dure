export const automations: Record<string, string> = {
	"automations.model": "Modelo",
	"automations.effort": "Esforço de raciocínio",
	"automations.providerDefault": "Padrão do provedor",
	"automations.title": "Automações",
	"automations.new": "Nova automação",
	"automations.intro":
		"Transforme tarefas recorrentes em um fluxo reutilizável.",
	"automations.runtime": "Ambiente: {name}",
	"automations.empty": "Nenhuma automação ainda",
	"automations.active": "Agendada",
	"automations.paused": "Pausada",
	"automations.limited": "Exibindo até 128 itens.",
	"automations.flow": "Fluxo",
	"automations.trigger": "Gatilho",
	"automations.agent": "Agente",
	"automations.result": "Resultado",
	"automations.retainedReport": "Relatório salvo",
	"automations.flowScope":
		"Um agente agendado com um relatório por execução. Selecione uma etapa para configurá-la.",
	"automations.expression": "Agendamento",
	"automations.cronHelp":
		"Cron de cinco campos: minuto, hora, dia, mês, dia da semana. Exemplo: 0 9 * * 1-5.",
	"automations.timezone": "Fuso horário",
	"automations.activation": "Execuções agendadas",
	"automations.runtimeHelp":
		"O ambiente deve estar ativo no horário agendado. Pausar impede novos disparos, sem interromper execuções em andamento.",
	"automations.project": "Projeto",
	"automations.noProjects":
		"Registre um projeto neste ambiente para criar uma automação.",
	"automations.chooseProject": "Escolha um projeto",
	"automations.provider": "Provedor do agente",
	"automations.prompt": "Instruções",
	"automations.permissions": "Permissões",
	"automations.defaultPermissions": "Padrões do provedor",
	"automations.requireApprovals": "Solicitar aprovação",
	"automations.skipPermissions": "Ignorar confirmações de permissão",
	"automations.worktreeHelp":
		"Cada execução usa um worktree Git separado e as credenciais configuradas do agente.",
	"automations.resultHelp":
		"Os relatórios ficam vinculados à execução original. Consulte-os em Execuções. Iniciar um agente não significa concluir; receber um relatório não comprova sucesso.",
	"automations.runs": "Execuções",
	"automations.recentRuns": "Execuções recentes",
	"automations.noRuns": "Nenhuma execução ainda",
	"automations.manual": "Manual",
	"automations.scheduled": "Agendada",
	"automations.runRevision": "Versão da configuração {revision}",
	"automations.noReport": "Nenhum relatório recebido para esta execução.",
	"automations.workspace": "Espaço de trabalho",
	"automations.saveFirst": "Salve a configuração antes de executar.",
	"automations.name": "Nome",
	"automations.pause": "Pausar agendamento",
	"automations.testRun": "Executar",
	"automations.reportReceived": "Relatório recebido",
	"automations.awaitingDecision": "Aguardando decisão",
	"automations.startFailed": "Falha ao iniciar",
	"automations.queued": "Na fila",
	"automations.awaitingReport": "Iniciada · aguardando relatório",
	"automations.invalidResponse":
		"O ambiente retornou uma resposta de automação inválida.",
	"automations.requestFailed":
		"Não foi possível acessar o ambiente de automação.",
	"automations.conflict":
		"Esta automação foi alterada em outro lugar. Feche o editor e atualize a lista.",
	"automations.retryHelp":
		"O resultado não foi confirmado. Tentar novamente envia a mesma solicitação sem duplicá-la.",
	"automations.closeUncertain":
		"Fechar com uma solicitação não confirmada? Ela ainda pode ser concluída.",
	"automations.discardQuestion": "Descartar alterações não salvas?",
	"automations.graph.projectLookupFailed":
		"A lista de projetos está indisponível. Informe um diretório nas etapas Command.",
	"automations.graph.editor": "Editor",
	"automations.graph.draft": "Rascunho",
	"automations.graph.pause": "Pausar automação",
	"automations.graph.active": "Ativo",
	"automations.graph.saveDraft": "Salvar rascunho",
	"automations.graph.activate": "Ativar versão",
	"automations.graph.draftVersion": "Rascunho · versão ativa {version}",
	"automations.graph.version": "Versão {version}",
	"automations.graph.stepCount": "Etapas: {count}",
	"automations.graph.manual": "Manual",
	"automations.graph.schedule": "Agendamento",
	"automations.graph.canvas": "Tela do fluxo",
	"automations.graph.addStep": "Adicionar etapa",
	"automations.graph.addStepHelp":
		"Selecione uma etapa e adicione outra para conectá-las. Mapeie as saídas nas configurações.",
	"automations.graph.emptyCanvas":
		"Adicione um comando ou agente, ou comece pela revisão diária.",
	"automations.graph.selectStep":
		"Selecione uma etapa para ver as configurações.",
	"automations.graph.selectToConfigure": "Selecione para configurar",
	"automations.graph.needsSetup": "Requer configuração",
	"automations.graph.stepSettings": "Configurações da etapa",
	"automations.graph.stepName": "Nome da etapa",
	"automations.graph.advanced": "Configurações avançadas",
	"automations.graph.runAfter": "Executar após",
	"automations.graph.addConnection": "Adicionar dependência",
	"automations.graph.mappedConnection":
		"Esta conexão fornece uma entrada mapeada. Altere a origem para removê-la.",
	"automations.graph.removeConnection": "Remover conexão",
	"automations.graph.deleteStep": "Remover etapa",
	"automations.graph.deleteConfirm": "Remover esta etapa?",
	"automations.graph.closeEditor": "Fechar editor",
	"automations.graph.inputSource": "Origem de {field}",
	"automations.graph.literal": "Inserir um valor",
	"automations.graph.missingSource": "Referência de saída ausente",
	"automations.graph.schemaOnly":
		"Apenas o campo de saída. Os valores reais aparecem após executar.",
	"automations.graph.directoryHelp":
		"Escolha um projeto ou informe um diretório absoluto neste ambiente.",
	"automations.graph.scriptHelp":
		"Executa com /bin/sh. Os dados mapeados são enviados pela entrada padrão.",
	"automations.graph.chooseProvider": "Escolher provedor",
	"automations.graph.zoomIn": "Ampliar",
	"automations.graph.zoomOut": "Reduzir",
	"automations.graph.fitView": "Ajustar fluxo",
	"automations.graph.keyboardHelp":
		"Enter seleciona uma etapa. As setas a movem. Altere conexões nas configurações.",
	"automations.graph.connectionHelp":
		"As conexões indicam dependências. Edite-as nas configurações da etapa.",
	"automations.graph.nodeMoved": "Etapa movida para {x}, {y}.",
	"automations.graph.connectionPoint": "Ponto de conexão",
	"automations.graph.stepResult": "Resultado da etapa",
	"automations.graph.inputs": "Entradas",
	"automations.graph.outputs": "Saídas",
	"automations.graph.noRuns": "Nenhuma execução ainda",
	"automations.graph.notStarted": "Esta etapa não foi iniciada.",
	"automations.graph.waitingOutput": "Aguardando a saída desta etapa.",
	"automations.graph.fromStep": "De {name} · {field}",
	"automations.graph.failedHelp":
		"Falha na etapa: {code}. As etapas seguintes não foram executadas.",
	"automations.graph.uncertainHelp":
		"Resultado desconhecido: {code}. Verifique os efeitos antes de executar novamente.",
	"automations.graph.activeHelp":
		"As execuções manuais usam o rascunho salvo. As execuções agendadas usam a versão ativa.",
	"automations.graph.draftHelp":
		"Salve um rascunho para executá-lo uma vez. Ative uma versão para habilitar o agendamento.",
	"automations.graph.dailyReview": "Revisão diária",
	"automations.graph.collectChanges": "Coletar alterações recentes",
	"automations.graph.reviewChanges": "Revisar alterações",
	"automations.graph.reviewPrompt":
		"Revise as alterações fornecidas das últimas 24 horas. Inspecione o código relevante e relate riscos concretos, evidências e verificações sugeridas. Não faça merge nem implante alterações.",
	"automations.graph.actions.agent": "Agente",
	"automations.graph.actions.command": "Comando",
	"automations.graph.states.pending": "Não iniciado",
	"automations.graph.states.started": "Em execução",
	"automations.graph.states.running": "Em execução",
	"automations.graph.states.completed": "Concluído",
	"automations.graph.states.failed": "Falhou",
	"automations.graph.states.uncertain": "Resultado desconhecido",
	"automations.graph.fields.script": "Comando shell",
	"automations.graph.fields.directory": "Diretório de trabalho",
	"automations.graph.fields.projectId": "Projeto",
	"automations.graph.fields.providerId": "Provedor do agente",
	"automations.graph.fields.prompt": "Instruções",
	"automations.graph.fields.input": "Contexto de entrada",
	"automations.graph.fields.stdin": "Entrada padrão",
	"automations.graph.fields.stdout": "Saída padrão",
	"automations.graph.fields.stderr": "Saída de erro",
	"automations.graph.fields.exitCode": "Código de saída",
	"automations.graph.fields.resultMarkdown": "Relatório do agente",
	"automations.graph.fields.timeoutSeconds": "Tempo limite em segundos",
	"automations.graph.fields.executionProfile": "Perfil de execução (JSON)",
	"automations.graph.fields.permissionMode": "Permissões",
	"automations.graph.issues.missingInput": "Escolha ou insira esta entrada.",
	"automations.graph.issues.missingOutput":
		"A saída de origem está ausente ou é opcional. Escolha outro campo.",
	"automations.graph.issues.typeMismatch": "O tipo desta saída é incompatível.",
	"automations.graph.issues.literalRequired":
		"Insira um valor fixo para esta configuração.",
	"automations.graph.issues.cycle":
		"As conexões formam um ciclo. Remova uma dependência.",
	"automations.graph.issues.unsupportedAction":
		"Esta versão da ação não está disponível neste ambiente.",
	"automations.graph.issues.locationRequired":
		"Escolha um projeto ou um diretório absoluto existente.",
	"automations.graph.issues.timeoutInvalid":
		"Use 1–300 segundos para comandos ou 1–86400 para agentes.",
	"automations.graph.issues.projectUnavailable":
		"Este projeto não está registrado no ambiente selecionado.",
	"automations.graph.issues.requiredValue":
		"Insira texto não vazio dentro do limite da ação.",
	"automations.graph.issues.empty": "Adicione uma etapa para começar.",
	"automations.graph.issues.revisionConflict":
		"O fluxo foi alterado em outro lugar. Reabra para carregar a versão mais recente.",
	"automations.graph.issues.invalid": "Verifique esta configuração ({code}).",
};
