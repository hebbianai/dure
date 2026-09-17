export const ipc: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"O executável do provedor não foi encontrado no host de execução. Instale nele o provedor selecionado ou corrija PATH e tente esta solicitação novamente.",
	"ipc.dureRun.providerNotExecutable":
		"O executável do provedor não pode ser executado. Verifique o caminho e as permissões de execução no host e tente esta solicitação novamente.",
	"ipc.dureRun.providerLookupFailed":
		"O Dure não conseguiu inspecionar o executável do provedor no host de execução. Verifique o caminho e as permissões de acesso e tente esta solicitação novamente.",
	"ipc.dureRun.providerPathMissing":
		"PATH não está disponível no host de execução. Restaure-o e tente esta solicitação novamente.",
	"ipc.browser.invalidResponse":
		"Não foi possível ler o estado do navegador. Atualize o pane.",
	"ipc.browser.connectionChanged":
		"A conexão do navegador mudou. Reconecte-se para escolher um navegador.",
	"ipc.browser.unavailable":
		"Este navegador não está mais disponível. Reconecte-se para escolher um navegador.",
	"ipc.browser.developmentRequired":
		"O Pro Browser requer um backend de desenvolvimento compatível. Atualize o backend selecionado e conecte-se novamente.",
	"ipc.browser.runtimeRequired":
		"O ambiente de execução do navegador não está instalado no backend selecionado. Instale-o nesse backend antes de criar um navegador.",
	"ipc.browser.requestFailed":
		"A solicitação do navegador não terminou. Verifique o estado antes de tentar novamente.",
	"ipc.agentConversation.invalidResponse": "A resposta da conversa do agente é inválida.",
	"ipc.agentConversation.requestFailed": "A solicitação de conversa do agente falhou.",
	"ipc.agentConversation.deliveryUnconfirmed": "Não foi possível confirmar a entrega da mensagem. Verifique a conversa antes de enviar novamente.",
	"ipc.dureBackend.generationChanged": "A geração do backend do Dure mudou. Tente novamente com a mesma solicitação.",
	"ipc.dureCoordinator.bindingMismatch": "A resposta do vínculo do coordenador não corresponde ao painel atual.",
	"ipc.dureDelegation.invalidResponse": "O backend do Dure retornou uma resposta de delegação inválida.",
	"ipc.dureDelegation.receiptMismatch": "O backend do Dure retornou um recibo de delegação que não corresponde à solicitação.",
	"ipc.dureDelegation.requestFailed": "A solicitação de delegação do Dure falhou.",
	"ipc.dureDispatch.inspectionReceiptMismatch": "O recibo de inspeção de Dispatch do Dure não corresponde à sessão exata.",
	"ipc.dureDispatch.rebindReceiptMismatch": "O recibo de revinculação de Dispatch do Dure não corresponde às sessões selecionadas pelo journal.",
	"ipc.dureOrchestration.apiResponseMismatch": "A resposta da API de orquestração do Dure não corresponde à solicitação.",
	"ipc.dureOrchestration.authorityGenerationChanged": "A geração da autoridade de orquestração do Dure mudou; a caixa de entrada será ressincronizada.",
	"ipc.dureOrchestration.invalidResponse": "O formato da resposta de orquestração do Dure é inválido.",
	"ipc.dureOrchestration.receiptContractMismatch": "O recibo de orquestração do Dure não corresponde ao contrato.",
	"ipc.dureOrchestration.requestFailed": "A solicitação de orquestração do Dure falhou.",
	"ipc.dureOrchestration.responseMismatch": "A resposta de orquestração do Dure não corresponde à solicitação.",
	"ipc.dureRun.invalidResponse": "O backend do Dure retornou uma resposta de Run inválida.",
	"ipc.dureRun.stageFailed": "Não foi possível iniciar o agente — a etapa {stage} falhou ({code}). Tente novamente.",
	"ipc.dureRun.promptUncertain": "O agente iniciou, mas nunca confirmou o prompt ({code}). Verifique o terminal dele antes de enviar de novo.",
	"ipc.dureRun.receiptMismatch": "O backend do Dure retornou um recibo de Run que não corresponde à solicitação.",
	"ipc.dureRun.requestFailed": "A solicitação de Run ao backend do Dure falhou.",
};
