<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### Vous donnez le cap.<br>Vos agents travaillent ensemble.

Un **Agent Development Environment (ADE)** pour vos agents de programmation IA.<br>
Projets, conversations, terminaux et modifications de code, réunis dans un espace de travail macOS.

**[Télécharger pour macOS](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [Site web](https://www.dureai.dev/) &nbsp;·&nbsp; [Documentation (anglais)](https://docs.dureai.dev/en/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · Gardez vos outils de programmation en ligne de commande et vos comptes</sub>

[English](../../README.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · **Français** · [Português](README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="../../public/readme/workspace-tour.webp" alt="Dure avec Claude Code, Codex, Pi et un shell dans six volets, et les projets et sessions dans Spaces" width="960" />
</a>

**[▶ Découvrir Dure en 29 secondes](https://www.dureai.dev/#hero-film)** · [Télécharger le MP4](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>Capture de l'application native, avec de vrais agents en ligne de commande dans un projet d'exemple.<br>La liste des issues GitHub utilise des données de démonstration. La capture provient d'une version de développement ; la version téléchargée peut différer.</sub>

</div>

## Plus d'agents. Un seul endroit pour les guider.

Le plus difficile n'est pas de lancer un agent de plus. C'est de savoir quelle tâche a besoin de vous, ce qui a changé et quoi faire ensuite.

Dure rassemble ce travail au même endroit. Placez Claude Code à côté de Codex et de Pi. Suivez les sessions de plusieurs projets et machines SSH. Lisez les différences, envoyez vos retours et donnez une direction claire à la tâche suivante.

## De la première tâche à la revue finale

### 01 — Commencez par un objectif

Appuyez sur **⌘N**, décrivez la tâche, puis choisissez un projet et un fournisseur. Attribuez un Git worktree et une branche dédiés aux tâches qui doivent modifier des fichiers indépendamment. Vous pouvez aussi choisir **Start** sur une issue GitHub pour ouvrir une tâche préremplie.

### 02 — Organisez votre attention

Divisez les volets, déplacez les onglets, changez de bureau ou ouvrez une session dans sa propre fenêtre. Spaces réunit le travail local et SSH, avec des indicateurs d'activité et de changements pour repérer ce qui mérite votre attention.

<table>
<tr>
<td width="50%">
<a href="https://docs.dureai.dev/en/quickstart"><img src="../../public/readme/start-agent.png" alt="Fenêtre New agent ouverte avec Command-N, proposant la tâche, le projet, le fournisseur et un worktree dédié" width="460" /></a>
<br><sub>Décrivez le travail. Choisissez l'agent.</sub>
</td>
<td width="50%">
<a href="https://docs.dureai.dev/en/spaces-and-panes"><img src="../../public/readme/pane-arrangement.png" alt="Déplacement d'un onglet de terminal actif vers la zone Split Right de Dure" width="460" /></a>
<br><sub>Déplacez la vue. Gardez le contexte.</sub>
</td>
</tr>
</table>

### 03 — Relisez et orientez

Examinez les changements locaux, y compris les fichiers nouveaux et les modifications non commitées. Ajoutez des commentaires de ligne et renvoyez-les à l'agent. Vérifiez le code et les résultats des tests avant d'intégrer le travail : vous décidez de la suite.

[Votre premier agent →](https://docs.dureai.dev/en/quickstart) &nbsp; [Tâches en parallèle →](https://docs.dureai.dev/en/first-parallel-workflow) &nbsp; [Revue et retours →](https://docs.dureai.dev/en/review-and-feedback)

## L'espace de travail autour de vos agents

| Lorsque vous devez… | Dure propose… |
| --- | --- |
| Avancer sur des tâches indépendantes | Des Git worktrees et des branches dédiés, avec les fichiers de chaque tâche séparés. |
| Suivre le travail en cours | Spaces, volets divisés, bureaux et fenêtres indépendantes entre projets. |
| Revenir après avoir fermé l'application | La reconnexion aux sessions gérées encore actives ; un parcours de récupération distinct pour les processus terminés. |
| Travailler sur plusieurs machines | Des projets SSH et terminaux distants à côté du travail local, avec collage d'images et transfert de fichiers. |
| Utiliser vos comptes habituels | Des profils par agent et l'usage communiqué par les fournisseurs compatibles. |
| Relier les tâches récurrentes | Des exécutions et planifications CLI ; des messages, demandes de décision et comptes rendus via CLI/MCP. |
| Personnaliser votre environnement | Des thèmes, la typographie du terminal et une interface en sept langues. |

### Vos outils. Vos comptes.

Utilisez les CLI natives d'agents de programmation comme **Claude Code, Codex, Pi, Gemini CLI, OpenCode et Kimi Code**. Dure est un espace de travail, pas un modèle ni un abonnement à un fournisseur. Les abonnements et frais d'utilisation des fournisseurs restent distincts.

La prise en charge du terminal, l'historique des conversations, les vues de chat et les outils de compte varient selon le fournisseur. [Consulter les capacités par fournisseur →](https://docs.dureai.dev/en/providers)

## Commencez sur votre Mac

1. **[Téléchargez Dure pour macOS](https://www.dureai.dev/download/mac/)** sur un Mac Apple Silicon. Ouvrez l'image disque et déplacez l'application dans **Applications**.
2. Installez au moins une CLI d'agent compatible et connectez-vous à votre compte. Suivez le [guide d'installation](https://docs.dureai.dev/en/install), y compris les consignes de sécurité macOS.
3. Ouvrez dans Dure un projet Git que vous connaissez. Appuyez sur **⌘N** et commencez par une petite tâche.

Essayez d'abord ceci :

```text
Trouve comment exécuter les tests de ce dépôt.
Ne modifie aucun fichier.
Indique les commandes et les fichiers qui les documentent.
```

### Quelques limites à connaître

- **Les worktrees séparent les fichiers, pas les permissions.** Ce ne sont pas des bacs à sable de sécurité : ils n'isolent ni les identifiants, ni les processus, ni l'accès au réseau. Des conflits restent possibles lors de l'intégration des changements.
- **L'hôte doit rester actif.** Les sessions gérées peuvent continuer sans la fenêtre de l'application tant que le processus hôte et la machine fonctionnent. Un redémarrage termine le processus d'origine ; la récupération en crée un autre.
- **La revue reste nécessaire.** Vérifiez les permissions de l'agent, les modifications et les résultats de validation avant d'accepter le travail. Le changement de compte et les sessions distantes ont des limites liées aux fournisseurs et à l'environnement d'exécution.

[Sessions et récupération](https://docs.dureai.dev/en/session-model) · [SSH](https://docs.dureai.dev/en/remote-and-ssh) · [Travailler en sécurité](https://docs.dureai.dev/en/current-limits)

<sub>Les liens de documentation de cette traduction renvoient à la version anglaise.</sub>

## Disponibilité du code source

**Licence : [MIT](../../LICENSE) · Copyright (c) 2026 Hebbian AI.**

Le code propre à Dure est disponible dans ce dépôt sous licence MIT. Les composants tiers conservent leurs licences et mentions de copyright.

Consultez le [guide de contribution](../../CONTRIBUTING.md#source-and-development) pour compiler depuis les sources. L'application se télécharge sur le [site web](https://www.dureai.dev/download/mac/).

## Contribuer

Consultez le [guide de contribution](../../CONTRIBUTING.md) et le [code de conduite](../../CODE_OF_CONDUCT.md), ou [signalez un bug ou proposez une fonctionnalité](https://github.com/hebbianai/dure/issues/new/choose). Pour les vulnérabilités, utilisez le canal privé indiqué dans la [politique de sécurité](../../SECURITY.md). Les documents de contribution et de communauté sont actuellement disponibles en anglais.

---

<div align="center">

**Vous donnez le cap. Vos agents travaillent ensemble.**

[Télécharger Dure](https://www.dureai.dev/download/mac/) · [Lire la documentation](https://docs.dureai.dev/en/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
