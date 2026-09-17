export const feedback: Record<string, string> = {
	"feedback.command": "Enviar feedback",
	"feedback.dialog.title": "Enviar feedback",
	"feedback.dialog.description":
		"Relate um bug, compartilhe uma ideia ou nos conte outra coisa. Confira abaixo exatamente o que será enviado.",
	"feedback.dialog.notice.title": "O que é incluído",
	"feedback.dialog.notice.withScreenshot":
		"Sua mensagem, os seis valores de ambiente abaixo, um contato opcional e um token aleatório por instalação usado apenas para limitar a frequência. Esses campos nunca incluem conteúdo do terminal, código ou credenciais. A captura de tela inclui: ela envia esta janela exatamente como estava, com a saída do terminal. Clique na miniatura para vê-la em tamanho real.",
	"feedback.dialog.notice.withoutScreenshot":
		"Sua mensagem, os seis valores de ambiente abaixo, um contato opcional e um token aleatório por instalação usado apenas para limitar a frequência. Nenhuma captura de tela é anexada, então nada do que estava na tela é enviado. Esses campos nunca incluem conteúdo do terminal, código ou credenciais.",
	"feedback.dialog.kindLabel": "Sobre o que é isso?",
	"feedback.dialog.kind.bug": "Bug",
	"feedback.dialog.kind.idea": "Ideia",
	"feedback.dialog.kind.other": "Outro",
	"feedback.dialog.bodyLabel": "O que aconteceu?",
	"feedback.dialog.bodyPlaceholder":
		"Descreva o que aconteceu, o que você esperava e como reproduzir.",
	"feedback.dialog.contactLabel": "Contato (opcional)",
	"feedback.dialog.contactPlaceholder": "E-mail, para podermos responder",
	"feedback.dialog.screenshot.title": "Captura de tela",
	"feedback.dialog.screenshot.expand": "Ver em tamanho real",
	"feedback.dialog.screenshot.collapse": "Ocultar o tamanho real",
	"feedback.dialog.screenshot.fullAlt": "Captura desta janela em tamanho real",
	"feedback.dialog.screenshot.included":
		"Uma captura de tela desta janela está anexada.",
	"feedback.dialog.screenshot.removed": "Captura de tela não incluída.",
	"feedback.dialog.screenshot.permissionTitle":
		"Permissão de gravação de tela necessária",
	"feedback.dialog.screenshot.permissionBody":
		"O Dure não conseguiu capturar a tela porque a permissão de Gravação de Tela do macOS não foi concedida. Abra Ajustes do Sistema › Privacidade e Segurança › Gravação de Tela, ative o Dure e reabra esta caixa de diálogo — ou envie seu relatório sem uma captura.",
	"feedback.dialog.screenshot.captureFailed":
		"Não foi possível capturar a tela: {reason}",
	"feedback.dialog.environment.summary": "Ambiente",
	"feedback.dialog.environment.os": "SO",
	"feedback.dialog.environment.arch": "Arquitetura",
	"feedback.dialog.environment.locale": "Idioma",
	"feedback.dialog.environment.window": "Janela",
	"feedback.dialog.environment.app": "Build do app",
	"feedback.dialog.environment.channel": "Canal",
	"feedback.dialog.previewLabel": "Pré-visualização exata do relatório",
	"feedback.dialog.send": "Enviar",
	"feedback.dialog.sent": "Enviado",
	"feedback.dialog.sending": "Enviando…",
	"feedback.dialog.retry": "Tentar novamente",
	"feedback.dialog.copyReport": "Copiar relatório",
	"feedback.dialog.copySuccess": "Relatório de feedback copiado.",
	"feedback.dialog.copyFailed":
		"Não foi possível copiar o relatório de feedback: {error}",
	"feedback.dialog.sentNotice": "Enviado — referência {reference}.",
	"feedback.dialog.error.rejected":
		"O Dure não conseguiu aceitar este relatório: {message}",
	"feedback.dialog.error.rateLimited":
		"Muitos relatórios enviados por este dispositivo recentemente. Tente novamente em instantes.",
	"feedback.dialog.error.temporary":
		"O serviço de feedback está temporariamente indisponível. Seu relatório continua aqui — tente novamente em breve.",
	"feedback.dialog.error.network":
		"Não foi possível conectar ao serviço de feedback. Verifique sua conexão e tente novamente.",
	"feedback.dialog.error.attachmentTooLarge":
		"A captura de tela é grande demais para ser enviada.",
	"feedback.dialog.sendWithoutScreenshot": "Enviar sem a captura de tela",
};
