<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### Você lidera.<br>Seus agentes trabalham juntos.

Um **Agent Development Environment (ADE)** para seus agentes de programação com IA.<br>
Projetos, conversas, terminais e alterações de código — juntos em um único espaço de trabalho no macOS.

**[Baixar para macOS](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [Site](https://www.dureai.dev/) &nbsp;·&nbsp; [Documentação (inglês)](https://docs.dureai.dev/en/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · Use suas CLIs de agentes de programação e suas contas de sempre</sub>

[English](../../README.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · **Português**

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="../../public/readme/workspace-tour.webp" alt="Dure com Claude Code, Codex, Pi e um shell em seis painéis, com projetos e sessões no Spaces" width="960" />
</a>

**[▶ Conheça o Dure em 29 segundos](https://www.dureai.dev/#hero-film)** · [Baixar MP4](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>Gravação do aplicativo nativo com CLIs de agentes reais em um projeto de exemplo.<br>A lista de issues do GitHub usa dados de demonstração. A gravação foi feita em uma versão de desenvolvimento; a versão baixada pode ser diferente.</sub>

</div>

## Mais agentes. Um só lugar para liderar.

O difícil não é iniciar mais um agente. É saber qual tarefa precisa de você, o que mudou e o que fazer em seguida.

O Dure reúne esse trabalho em um só lugar. Coloque Claude Code ao lado de Codex e Pi. Acompanhe sessões em diferentes projetos e máquinas SSH. Leia as diferenças, envie feedback e defina o rumo da próxima tarefa.

O nome vem de **두레**, uma tradição coreana de trabalho coletivo nas comunidades agrícolas. Mãos diferentes, trabalho compartilhado. Você define a direção.

## Da primeira tarefa à revisão final

### 01 — Comece com um objetivo

Pressione **⌘N**, descreva a tarefa e escolha um projeto e um provedor. Dê um Git worktree e uma branch próprios às tarefas que precisam editar arquivos de forma independente. Você também pode escolher **Start** em uma issue do GitHub para abrir uma tarefa já preenchida.

### 02 — Organize sua atenção

Divida painéis, mova abas, alterne entre áreas de trabalho ou abra uma sessão em sua própria janela. O Spaces reúne o trabalho local e via SSH, com indicadores de atividade e alterações para encontrar o que precisa de atenção.

<table>
<tr>
<td width="50%">
<a href="https://docs.dureai.dev/en/quickstart"><img src="../../public/readme/start-agent.png" alt="Janela New agent aberta com Command-N, com opções de tarefa, projeto, provedor e worktree dedicado" width="460" /></a>
<br><sub>Descreva o trabalho. Escolha o agente.</sub>
</td>
<td width="50%">
<a href="https://docs.dureai.dev/en/spaces-and-panes"><img src="../../public/readme/pane-arrangement.png" alt="Uma aba de terminal em execução sendo arrastada para a área Split Right do Dure" width="460" /></a>
<br><sub>Mova a visualização. Preserve o contexto.</sub>
</td>
</tr>
</table>

### 03 — Revise e oriente

Inspecione as alterações locais, incluindo arquivos novos e alterações ainda sem commit. Adicione comentários por linha e envie-os de volta ao agente. Confira as mudanças e os resultados dos testes antes de integrar o trabalho — você decide o próximo passo.

[Seu primeiro agente →](https://docs.dureai.dev/en/quickstart) &nbsp; [Tarefas em paralelo →](https://docs.dureai.dev/en/first-parallel-workflow) &nbsp; [Revisão e feedback →](https://docs.dureai.dev/en/review-and-feedback)

## O espaço de trabalho ao redor dos seus agentes

| Quando você precisa… | O Dure oferece… |
| --- | --- |
| Trabalhar em tarefas independentes | Git worktrees e branches dedicados, mantendo os arquivos de cada tarefa separados. |
| Acompanhar o trabalho em andamento | Spaces, painéis divididos, áreas de trabalho e janelas independentes entre projetos. |
| Voltar depois de fechar o app | Reconexão a sessões gerenciadas ainda ativas; um fluxo separado de recuperação para processos encerrados. |
| Trabalhar em várias máquinas | Projetos SSH e terminais remotos ao lado do trabalho local, com colagem de imagens e transferência de arquivos. |
| Usar suas contas existentes | Perfis por agente e uso informado pelo provedor, quando disponíveis. |
| Conectar tarefas recorrentes | Execuções e agendamentos pela CLI; mensagens, pedidos de decisão e relatórios de conclusão via CLI/MCP. |
| Personalizar seu ambiente | Temas, tipografia do terminal e interface em sete idiomas. |

### Suas ferramentas. Suas contas.

Use CLIs nativas de agentes de programação como **Claude Code, Codex, Pi, Gemini CLI, OpenCode e Kimi Code**. O Dure é um espaço de trabalho, não um modelo nem uma assinatura de provedor. Assinaturas e cobranças por uso dos provedores continuam separadas.

O suporte ao terminal, o histórico de conversas, as visualizações de chat e as ferramentas de conta variam conforme o provedor. [Veja os recursos de cada provedor →](https://docs.dureai.dev/en/providers)

## Comece no seu Mac

1. **[Baixe o Dure para macOS](https://www.dureai.dev/download/mac/)** em um Mac com Apple Silicon. Abra a imagem de disco e mova o app para **Aplicativos**.
2. Instale pelo menos uma CLI de agente compatível e entre na sua conta. Siga o [guia de instalação](https://docs.dureai.dev/en/install), incluindo as orientações de segurança do macOS.
3. Abra no Dure um projeto Git que você conheça. Pressione **⌘N** e comece com uma tarefa pequena.

Experimente primeiro:

```text
Descubra como executar os testes deste repositório.
Não modifique nenhum arquivo.
Informe os comandos e os arquivos que os documentam.
```

### Alguns limites importantes

- **Worktrees separam arquivos, não permissões.** Não são ambientes de isolamento de segurança: não isolam credenciais, processos ou acesso à rede. As alterações ainda podem entrar em conflito ao serem integradas.
- **O host precisa continuar ativo.** Sessões gerenciadas podem continuar sem a janela do app enquanto o processo host e a máquina estiverem em execução. Reiniciar a máquina encerra o processo original; a recuperação cria outro.
- **A revisão continua necessária.** Confira as permissões do agente, as alterações e os resultados de validação antes de aceitar o trabalho. A troca de contas e as sessões remotas têm limites conforme o provedor e o ambiente de execução.

[Sessões e recuperação](https://docs.dureai.dev/en/session-model) · [SSH](https://docs.dureai.dev/en/remote-and-ssh) · [Segurança do trabalho](https://docs.dureai.dev/en/current-limits)

<sub>Os links de documentação desta tradução levam à versão em inglês.</sub>

## Disponibilidade do código-fonte

**Open-source release: TBD. — Publicação como código aberto: a definir.**

**Licença: [MIT](../../LICENSE) · Copyright (c) 2026 Hebbian AI.**

Este é o repositório público oficial do Dure no GitHub para informações e mídia do produto e o destino da futura publicação do código-fonte. O código próprio do Dure será publicado aqui sob a licença MIT; os componentes de terceiros manterão suas licenças e avisos de direitos autorais. O código-fonte do aplicativo ainda não é público e a data de publicação não foi anunciada.

O aplicativo está disponível no [site](https://www.dureai.dev/download/mac/); este repositório não é uma distribuição do código-fonte nem um guia de compilação.

## Contribuir

Consulte o [guia de contribuição](../../CONTRIBUTING.md) e o [código de conduta](../../CODE_OF_CONDUCT.md), ou [relate um erro ou proponha uma funcionalidade](https://github.com/hebbianai/dure/issues/new/choose). Para vulnerabilidades, use o canal privado da [política de segurança](../../SECURITY.md). Os documentos de contribuição e comunidade estão disponíveis por enquanto em inglês.

---

<div align="center">

**Você lidera. Seus agentes trabalham juntos.**

[Baixar Dure](https://www.dureai.dev/download/mac/) · [Ler a documentação](https://docs.dureai.dev/en/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
