<div align="center">

<a href="https://www.dureai.dev/">
  <img src="./public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### You lead.<br>Your agents work together.

An **open-source workspace for AI coding agents**.<br>
Coordinate Claude Code, Codex and Pi across projects and SSH hosts, with dedicated worktrees and code review built in.

**[Download for macOS](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [Website](https://www.dureai.dev/) &nbsp;·&nbsp; [Documentation](https://docs.dureai.dev/en/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · Bring your own coding-agent CLIs and accounts</sub>

**English** · [한국어](docs/readme/README.ko.md) · [简体中文](docs/readme/README.zh.md) · [日本語](docs/readme/README.ja.md) · [Español](docs/readme/README.es.md) · [Français](docs/readme/README.fr.md) · [Português](docs/readme/README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="./public/readme/workspace-tour.webp" alt="Dure with Claude Code, Codex, Pi and a shell arranged in six panes, with projects and sessions in Spaces" width="960" />
</a>

**[▶ Watch Dure in 29 seconds](https://www.dureai.dev/#hero-film)** · [Download MP4](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>Native app footage with live coding-agent CLIs in a sample project.<br>The GitHub issue list uses demo data. Recorded on a development build; the downloaded version may differ.</sub>

</div>

## Four ways to move work forward

### Parallel agents, separate worktrees

Start an agent with **⌘N** or from a GitHub issue. Choose its project and provider, and give independent editing tasks their own Git worktree and branch.

[Start parallel work →](https://docs.dureai.dev/en/first-parallel-workflow)

<a href="https://docs.dureai.dev/en/first-parallel-workflow">
  <img src="public/readme/start-agent.png" alt="Choose the task, provider and dedicated-worktree option." width="880" />
</a>

<sub>Choose the task, provider and dedicated-worktree option.</sub>

### Spaces for local and SSH work

Group projects and sessions in Spaces. Split panes, move tabs and open separate windows while keeping local and SSH work in view.

[Spaces and panes →](https://docs.dureai.dev/en/spaces-and-panes) · [SSH setup](https://docs.dureai.dev/en/remote-and-ssh)

<a href="https://docs.dureai.dev/en/spaces-and-panes">
  <img src="public/readme/pane-arrangement.png" alt="Arrange running agent panes in a sample project." width="880" />
</a>

<sub>Arrange running agent panes in a sample project.</sub>

### Code review beside the conversation

Inspect local diffs, including uncommitted changes and new files. Add comments to a file or line, send them to the linked agent, and review the next revision before combining work.

[Review and feedback →](https://docs.dureai.dev/en/review-and-feedback)

<a href="https://docs.dureai.dev/en/review-and-feedback">
  <img src="docs/public/images/diff-review.png" alt="Inspect a sample project diff before adding review comments." width="880" />
</a>

<sub>Inspect a sample project diff before adding review comments.</sub>

### Runs, schedules and agent coordination

Launch tasks and schedule recurring work with the Dure CLI. CLI and MCP integrations carry progress messages, decision requests and completion reports between people and agents.

```sh
dure run --provider codex --worktree readme-review \
  "Review the README against the code. Do not change files."
dure ls
```

[CLI runs and schedules →](https://docs.dureai.dev/en/cli-and-automation) · [Messages and decisions](https://docs.dureai.dev/en/orchestration)

## Supported agents

**Claude Code · Codex · Pi · OpenCode · Gemini CLI · Kimi Code**

Use your installed coding-agent CLIs and existing provider accounts. Model access, subscriptions and usage charges stay with your providers.

Claude Code, Codex, OpenCode and Pi have structured-chat integrations where the installed runtime supports them. Terminal, history, resume and account features vary by provider. [Check provider capabilities →](https://docs.dureai.dev/en/providers)

## Install and platform status

| Platform | Current availability |
| --- | --- |
| macOS · Apple Silicon | [Official download](https://www.dureai.dev/download/mac/) |
| Windows | Source available; native desktop validation and public installer pending. |
| Linux | Source available; native desktop validation and public installer pending. |
| iOS | Source available; device validation and official distribution pending. |
| Android | Source available; device validation and official distribution pending. |

For source builds and verification details, see the [platform development guide](CONTRIBUTING.md#platforms).

### Start on your Mac

1. **[Download Dure for macOS](https://www.dureai.dev/download/mac/)** on an Apple Silicon Mac. Open the disk image and move the app to **Applications**.
2. Install and sign in to at least one supported coding-agent CLI. Follow the [installation guide](https://docs.dureai.dev/en/install), including its macOS security guidance.
3. Open a familiar Git project in Dure. Press **⌘N** and start with one small task.

<details>
<summary>A few boundaries worth knowing</summary>

- **Worktrees separate files, not permissions.** They are not security sandboxes; credentials, processes and network access are not isolated by a worktree. Changes can still conflict when combined.
- **A running host matters.** Managed sessions can outlive the app window while the host process and machine remain running. A reboot ends the original process; recovery creates a replacement.
- **Review still matters.** Check agent permissions, changes and verification results before accepting work. Account switching and remote-session behavior have provider and runtime limits.

[Sessions and recovery](https://docs.dureai.dev/en/session-model) · [SSH](https://docs.dureai.dev/en/remote-and-ssh) · [Work-safety guidance](https://docs.dureai.dev/en/current-limits)

</details>

### Develop from source

On an Apple Silicon Mac, install Git, Xcode Command Line Tools, the [pinned Node version](.node-version), and [rustup](https://rustup.rs/). Then run:

```sh
git clone https://github.com/hebbianai/dure.git
cd dure
corepack enable
pnpm install --frozen-lockfile
pnpm app:dev
```

This starts the development app and prepares its runtime and CLI. The first native build can take time. For local `.app` installation, tool setup, and Windows/Linux/iOS/Android instructions, see the [development installation guide](CONTRIBUTING.md#development-installation).

## Open-source boundary

Copyright (C) 2026 [Hebbian AI](COPYRIGHT).

The first-party desktop, mobile, runtime (including Hmux), CLI and service code published here is available under [GNU GPL version 3 only (GPL-3.0-only)](LICENSE); third-party components retain their licenses and notices. You may use, modify and redistribute the code under those licenses. Distribution of covered binaries requires providing Corresponding Source as specified by GPLv3. Earlier versions released under MIT remain available under those terms.

The Dure name, logo, app icons and distinction between community and Hebbian AI official builds are covered by [TRADEMARK.md](TRADEMARK.md).

Source licensing does not include access to operated services. Signing keys, deployment credentials and confidential business and operational records remain private.

## Contributing

Read the [contribution guide](CONTRIBUTING.md), follow our [Code of Conduct](CODE_OF_CONDUCT.md), or [report a bug or propose a feature](https://github.com/hebbianai/dure/issues/new/choose). For vulnerabilities, use the private channel in our [security policy](SECURITY.md).

- **Release notes:** [GitHub Releases](https://github.com/hebbianai/hebbian-releases/releases)
- **Privacy and telemetry:** [Privacy and telemetry](https://docs.dureai.dev/en/privacy-and-telemetry)
- **Community:** [Discord](https://discord.gg/aTuRV6DXhb)
- **Updates:** [X · @hebbianai_](https://x.com/hebbianai_)

---

<div align="center">

**You lead. Your agents work together.**

[Download Dure](https://www.dureai.dev/download/mac/) · [Read the docs](https://docs.dureai.dev/en/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
