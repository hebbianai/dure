<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### 你来掌舵。<br>智能体协同工作。

面向 AI 编程智能体的**开源工作区**。<br>
通过专用 worktree 和内置代码审阅，统一协调多个项目与 SSH 主机上的 Claude Code、Codex 和 Pi。

**[下载 macOS 版](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [官网](https://www.dureai.dev/) &nbsp;·&nbsp; [文档](https://docs.dureai.dev/cn/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · 沿用你的编程智能体 CLI 和账号</sub>

[English](../../README.md) · [한국어](README.ko.md) · **简体中文** · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="../../public/readme/workspace-tour.webp" alt="Dure 将 Claude Code、Codex、Pi 和 shell 排列在六个窗格中，并在 Spaces 中展示项目与会话" width="960" />
</a>

**[▶ 29 秒了解 Dure](https://www.dureai.dev/#hero-film)** · [下载 MP4](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>原生应用实录：编程智能体 CLI 在示例项目中真实运行。<br>GitHub 议题列表使用演示数据。视频录制于开发构建，下载版本的界面可能有所不同。</sub>

</div>

## 推进工作的四种方式

### 并行智能体，独立 worktree

通过 **⌘N** 或 GitHub 议题启动智能体。选择项目和提供商，为独立修改文件的任务分配专用 Git worktree 和分支。

[开始并行任务 →](https://docs.dureai.dev/cn/first-parallel-workflow)

<a href="https://docs.dureai.dev/cn/first-parallel-workflow">
  <img src="../../public/readme/start-agent.png" alt="选择任务、提供商和专用 worktree 选项。" width="880" />
</a>

<sub>选择任务、提供商和专用 worktree 选项。</sub>

### 用 Spaces 汇集本地与 SSH 工作

用 Spaces 整理项目和会话。拆分窗格、移动标签或打开独立窗口，同时查看本地和 SSH 上的工作。

[Spaces 与窗格 →](https://docs.dureai.dev/cn/spaces-and-panes) · [SSH 设置](https://docs.dureai.dev/cn/remote-and-ssh)

<a href="https://docs.dureai.dev/cn/spaces-and-panes">
  <img src="../../public/readme/pane-arrangement.png" alt="在示例项目中排列正在运行的智能体窗格。" width="880" />
</a>

<sub>在示例项目中排列正在运行的智能体窗格。</sub>

### 在对话旁审阅代码

查看本地 diff，包括尚未提交的修改和新文件。给文件或代码行添加评论，发送给关联的智能体，并在合并工作前审阅下一次修改。

[审阅与反馈 →](https://docs.dureai.dev/cn/review-and-feedback)

<a href="https://docs.dureai.dev/cn/review-and-feedback">
  <img src="../../docs/public/images/diff-review.png" alt="在添加审阅评论前检查示例项目的 diff。" width="880" />
</a>

<sub>在添加审阅评论前检查示例项目的 diff。</sub>

### CLI 运行、调度与智能体协作

使用 Dure CLI 启动任务并调度周期性工作。CLI 和 MCP 集成让人与智能体交换进度消息、决策请求和完成报告。

```sh
dure run --provider codex --worktree readme-review \
  "Review the README against the code. Do not change files."
dure ls
```

[CLI 运行与调度 →](https://docs.dureai.dev/cn/cli-and-automation) · [消息与决策](https://docs.dureai.dev/cn/orchestration)

## 支持的智能体

**Claude Code · Codex · Pi · OpenCode · Gemini CLI · Kimi Code**

使用已安装的编程智能体 CLI 和现有提供商账号。模型访问、订阅和使用费用仍由各提供商管理。

在所安装的运行时支持时，Claude Code、Codex、OpenCode 和 Pi 提供结构化聊天集成。终端、历史记录、恢复会话和账号功能因提供商而异。 [查看提供商功能 →](https://docs.dureai.dev/cn/providers)

## 安装与平台状态

| 平台 | 当前可用范围 |
| --- | --- |
| macOS · Apple Silicon | [官方下载](https://www.dureai.dev/download/mac/) |
| Windows | 源代码已公开；原生桌面验证和公开安装包尚待完成。 |
| Linux | 源代码已公开；原生桌面验证和公开安装包尚待完成。 |
| iOS | 源代码已公开；设备验证和官方分发尚待完成。 |
| Android | 源代码已公开；设备验证和官方分发尚待完成。 |

源码构建和验证详情见[各平台开发指南](../../CONTRIBUTING.md#platforms)。

### 在 Mac 上开始

1. 在 Apple Silicon Mac 上<strong><a href="https://www.dureai.dev/download/mac/">下载 macOS 版 Dure</a></strong>。打开磁盘映像，将应用拖入<strong>应用程序</strong>文件夹。
2. 安装至少一个受支持的编程智能体 CLI 并登录账号。阅读[安装指南](https://docs.dureai.dev/cn/install)，包括其中的 macOS 安全提示。
3. 在 Dure 中打开一个熟悉的 Git 项目。按下 **⌘N**，从一个小任务开始。

<details>
<summary>使用前需要了解的边界</summary>

- **Worktree 分离文件，不隔离权限。** 它不是安全沙箱，不会隔离凭据、进程或网络访问。合并变更时仍可能发生冲突。
- **宿主必须保持运行。** 只要宿主进程和机器仍在运行，托管会话就可以独立于应用窗口继续工作。重启机器会结束原进程；恢复会创建替代进程。
- **审阅仍然必要。** 接受工作前，请检查智能体权限、代码变更和验证结果。账号切换和远程会话行为受到提供商与运行时能力的限制。

[会话与恢复](https://docs.dureai.dev/cn/session-model) · [SSH](https://docs.dureai.dev/cn/remote-and-ssh) · [工作安全指南](https://docs.dureai.dev/cn/current-limits)

</details>

## 开源范围

本仓库发布的桌面端、移动端、运行时（包括 Hmux）、CLI 和服务自有代码以 [GNU GPL 仅限第 3 版（GPL-3.0-only）](../../LICENSE)提供；第三方组件保留各自的许可证和声明。你可以按照这些许可证使用、修改和再分发代码。分发受 GPL 约束的二进制文件时，必须按 GPLv3 的规定提供对应源代码（Corresponding Source）。此前以 MIT 发布的版本仍适用原有 MIT 条款。

Dure 名称、标志、应用图标以及社区构建与 Hebbian AI 官方构建的区别见 [TRADEMARK.md](../../TRADEMARK.md)。

源代码许可不包含运营服务的访问权。签名密钥、部署凭据以及机密商业和运营记录保持非公开。

## 参与贡献

请阅读[贡献指南](../../CONTRIBUTING.md)和[行为准则](../../CODE_OF_CONDUCT.md)，或[报告问题、提出功能建议](https://github.com/hebbianai/dure/issues/new/choose)。安全漏洞请通过[安全政策](../../SECURITY.md)中的私密渠道报告。贡献与社区文档目前以英语提供。

- **发行说明:** [GitHub Releases](https://github.com/hebbianai/hebbian-releases/releases)
- **隐私与遥测:** [隐私与遥测](https://docs.dureai.dev/cn/privacy-and-telemetry)
- **社区:** [Discord](https://discord.gg/aTuRV6DXhb)
- **动态:** [X · @hebbianai_](https://x.com/hebbianai_)

---

<div align="center">

**你来掌舵。智能体协同工作。**

[下载 Dure](https://www.dureai.dev/download/mac/) · [阅读文档](https://docs.dureai.dev/cn/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
