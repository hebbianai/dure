<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### Vous donnez le cap.<br>Vos agents travaillent ensemble.

Un **espace de travail open source pour les agents de programmation IA**.<br>
Coordonnez Claude Code, Codex et Pi entre vos projets et hôtes SSH, avec des worktrees dédiés et une revue de code intégrée.

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

<sub>Les liens de documentation de cette traduction renvoient à la version anglaise.</sub>

## Quatre façons de faire avancer le travail

### Des agents en parallèle, des worktrees séparés

Lancez un agent avec **⌘N** ou depuis une issue GitHub. Choisissez son projet et son fournisseur, puis attribuez un worktree et une branche Git dédiés aux tâches de modification indépendantes.

[Démarrer des tâches en parallèle →](https://docs.dureai.dev/en/first-parallel-workflow)

<a href="https://docs.dureai.dev/en/first-parallel-workflow">
  <img src="../../public/readme/start-agent.png" alt="Choisissez la tâche, le fournisseur et l&#x27;option de worktree dédié." width="880" />
</a>

<sub>Choisissez la tâche, le fournisseur et l'option de worktree dédié.</sub>

### Spaces pour le travail local et SSH

Regroupez projets et sessions dans Spaces. Divisez les panneaux, déplacez les onglets et ouvrez des fenêtres séparées tout en gardant le travail local et SSH en vue.

[Spaces et panneaux →](https://docs.dureai.dev/en/spaces-and-panes) · [Configurer SSH](https://docs.dureai.dev/en/remote-and-ssh)

<a href="https://docs.dureai.dev/en/spaces-and-panes">
  <img src="../../public/readme/pane-arrangement.png" alt="Organisez les panneaux d&#x27;agents actifs dans un projet d&#x27;exemple." width="880" />
</a>

<sub>Organisez les panneaux d'agents actifs dans un projet d'exemple.</sub>

### La revue de code à côté de la conversation

Examinez les diffs locaux, y compris les modifications non commitées et les nouveaux fichiers. Commentez un fichier ou une ligne, envoyez vos remarques à l'agent associé et relisez la révision suivante avant d'intégrer le travail.

[Revue et commentaires →](https://docs.dureai.dev/en/review-and-feedback)

<a href="https://docs.dureai.dev/en/review-and-feedback">
  <img src="../../docs/public/images/diff-review.png" alt="Examinez le diff d&#x27;un projet d&#x27;exemple avant d&#x27;ajouter des commentaires." width="880" />
</a>

<sub>Examinez le diff d'un projet d'exemple avant d'ajouter des commentaires.</sub>

### Exécutions, planification et coordination des agents

Lancez des tâches et planifiez du travail récurrent avec la CLI de Dure. Les intégrations CLI et MCP permettent aux personnes et aux agents de partager des messages de progression, des demandes de décision et des rapports de fin de tâche.

```sh
dure run --provider codex --worktree readme-review \
  "Review the README against the code. Do not change files."
dure ls
```

[Exécutions et planification CLI →](https://docs.dureai.dev/en/cli-and-automation) · [Messages et décisions](https://docs.dureai.dev/en/orchestration)

## Agents compatibles

**Claude Code · Codex · Pi · OpenCode · Gemini CLI · Kimi Code**

Utilisez les CLI d'agents déjà installées et vos comptes de fournisseur existants. L'accès aux modèles, les abonnements et les frais d'utilisation restent gérés par vos fournisseurs.

Claude Code, Codex, OpenCode et Pi disposent d'intégrations de chat structuré lorsque l'environnement installé les prend en charge. Les fonctions de terminal, d'historique, de reprise et de compte varient selon le fournisseur. [Consulter les capacités par fournisseur →](https://docs.dureai.dev/en/providers)

## Installation et disponibilité par plateforme

| Plateforme | Disponibilité actuelle |
| --- | --- |
| macOS · Apple Silicon | [Téléchargement officiel](https://www.dureai.dev/download/mac/) |
| Windows | Code disponible ; validation native de bureau et installateur public en attente. |
| Linux | Code disponible ; validation native de bureau et installateur public en attente. |
| iOS | Code disponible ; validation sur appareil et distribution officielle en attente. |
| Android | Code disponible ; validation sur appareil et distribution officielle en attente. |

Pour compiler les sources et consulter la couverture de vérification, voir le [guide de développement par plateforme](../../CONTRIBUTING.md#platforms).

### Commencer sur votre Mac

1. **[Téléchargez Dure pour macOS](https://www.dureai.dev/download/mac/)** sur un Mac Apple Silicon. Ouvrez l'image disque et déplacez l'application dans **Applications**.
2. Installez au moins une CLI d'agent compatible et connectez-vous à votre compte. Suivez le [guide d'installation](https://docs.dureai.dev/en/install), y compris les consignes de sécurité macOS.
3. Ouvrez dans Dure un projet Git que vous connaissez. Appuyez sur **⌘N** et commencez par une petite tâche.

<details>
<summary>Quelques limites à connaître</summary>

- **Les worktrees séparent les fichiers, pas les permissions.** Ce ne sont pas des bacs à sable de sécurité : ils n'isolent ni les identifiants, ni les processus, ni l'accès au réseau. Des conflits restent possibles lors de l'intégration des changements.
- **L'hôte doit rester actif.** Les sessions gérées peuvent continuer sans la fenêtre de l'application tant que le processus hôte et la machine fonctionnent. Un redémarrage termine le processus d'origine ; la récupération en crée un autre.
- **La revue reste nécessaire.** Vérifiez les permissions de l'agent, les modifications et les résultats de validation avant d'accepter le travail. Le changement de compte et les sessions distantes ont des limites liées aux fournisseurs et à l'environnement d'exécution.

[Sessions et récupération](https://docs.dureai.dev/en/session-model) · [SSH](https://docs.dureai.dev/en/remote-and-ssh) · [Travailler en sécurité](https://docs.dureai.dev/en/current-limits)

</details>

## Périmètre open source

Copyright (C) 2026 [Hebbian AI](../../COPYRIGHT).

Le code propre au projet publié ici pour le bureau, le mobile, le moteur d’exécution (dont Hmux), la CLI et les services est sous [GNU GPL version 3 uniquement (GPL-3.0-only)](../../LICENSE) ; les composants tiers conservent leurs licences et mentions. Vous pouvez utiliser, modifier et redistribuer le code selon ces licences. La distribution de binaires couverts par la GPL exige de fournir le code source correspondant (Corresponding Source) selon les modalités de la GPLv3. Les versions précédemment publiées sous MIT restent disponibles selon ces conditions.

[TRADEMARK.md](../../TRADEMARK.md) décrit l'utilisation du nom, du logo et des icônes de Dure, ainsi que la distinction entre les versions communautaires et les versions officielles de Hebbian AI.

La licence du code n'inclut pas l'accès aux services exploités. Les clés de signature, les identifiants de déploiement et les documents commerciaux et opérationnels confidentiels restent privés.

## Contribuer

Consultez le [guide de contribution](../../CONTRIBUTING.md) et le [code de conduite](../../CODE_OF_CONDUCT.md), ou [signalez un bug ou proposez une fonctionnalité](https://github.com/hebbianai/dure/issues/new/choose). Pour les vulnérabilités, utilisez le canal privé indiqué dans la [politique de sécurité](../../SECURITY.md). Les documents de contribution et de communauté sont actuellement disponibles en anglais.

- **Notes de version:** [GitHub Releases](https://github.com/hebbianai/hebbian-releases/releases)
- **Confidentialité et télémétrie:** [Confidentialité et télémétrie](https://docs.dureai.dev/en/privacy-and-telemetry)
- **Communauté:** [Discord](https://discord.gg/aTuRV6DXhb)
- **Actualités:** [X · @hebbianai_](https://x.com/hebbianai_)

---

<div align="center">

**Vous donnez le cap. Vos agents travaillent ensemble.**

[Télécharger Dure](https://www.dureai.dev/download/mac/) · [Lire la documentation](https://docs.dureai.dev/en/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
