<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### 你来掌舵。<br>智能体协同工作。

面向 AI 编程智能体的 **Agent Development Environment（ADE，智能体开发环境）**。<br>
将项目、对话、终端和代码变更汇聚到一个 macOS 工作空间。

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

## 更多智能体，一个指挥中心。

难的不是再启动一个智能体，而是知道哪个任务需要你、哪些内容变了，以及下一步该做什么。

Dure 把这些工作集中到一处。让 Claude Code、Codex 和 Pi 并排运行，跟进不同项目和 SSH 主机上的会话。阅读差异、发送反馈，再为下一个任务明确方向。

## 从第一个任务到最后一次审阅

### 01 — 从目标开始

按下 **⌘N**，描述任务，选择项目和提供商。为需要独立修改文件的任务分配专用 Git worktree 和分支。也可以在 GitHub 议题上选择 **Start**，打开已填入议题内容的任务。

### 02 — 把注意力放在需要的地方

拆分窗格、移动标签页、切换桌面，或在独立窗口中打开会话。Spaces 将本地和 SSH 工作放在同一视图中，通过活动和变更提示帮助你找到需要关注的任务。

<table>
<tr>
<td width="50%">
<a href="https://docs.dureai.dev/cn/quickstart"><img src="../../public/readme/start-agent.png" alt="通过 Command-N 打开的新建智能体窗口，包含任务、项目、提供商和专用 worktree 选项" width="460" /></a>
<br><sub>描述工作，选择智能体。</sub>
</td>
<td width="50%">
<a href="https://docs.dureai.dev/cn/spaces-and-panes"><img src="../../public/readme/pane-arrangement.png" alt="将运行中的终端标签拖到 Dure 的 Split Right 区域" width="460" /></a>
<br><sub>调整视图，保留工作上下文。</sub>
</td>
</tr>
</table>

### 03 — 审阅并引导

检查本地变更，包括未提交的修改和新文件。添加行内评论，并将反馈发回智能体。合并工作前，先检查代码变更和测试结果——下一步由你决定。

[启动第一个智能体 →](https://docs.dureai.dev/cn/quickstart) &nbsp; [并行任务 →](https://docs.dureai.dev/cn/first-parallel-workflow) &nbsp; [审阅与反馈 →](https://docs.dureai.dev/cn/review-and-feedback)

## 围绕智能体工作的完整空间

| 当你需要…… | Dure 提供…… |
| --- | --- |
| 并行处理独立任务 | 专用 Git worktree 和分支，让各任务的工作文件保持分离。 |
| 跟进正在运行的工作 | 跨项目的 Spaces、分屏窗格、桌面和独立窗口。 |
| 关闭应用后继续工作 | 重新连接仍在运行的托管会话；已结束的进程使用单独的恢复流程。 |
| 跨机器工作 | 与本地工作并排的 SSH 项目和远程终端，支持图片粘贴与文件传输。 |
| 使用已有账号 | 在受支持的提供商上使用每个智能体独立的账号配置及提供商报告的用量。 |
| 串联重复工作 | CLI 运行与计划任务；CLI/MCP 消息、决策请求和完成报告。 |
| 打造自己的工作空间 | 主题、终端字体设置，以及七种语言的界面。 |

### 你的工具，你的账号。

使用 **Claude Code、Codex、Pi、Gemini CLI、OpenCode、Kimi Code** 等原生编程智能体 CLI。Dure 是工作空间，不是模型或提供商订阅。提供商订阅和使用费用仍需单独支付。

终端支持、对话历史、聊天视图和账号工具因提供商而异。[查看提供商能力 →](https://docs.dureai.dev/cn/providers)

## 在 Mac 上开始

1. 在 Apple Silicon Mac 上<strong><a href="https://www.dureai.dev/download/mac/">下载 macOS 版 Dure</a></strong>。打开磁盘映像，将应用拖入<strong>应用程序</strong>文件夹。
2. 安装至少一个受支持的编程智能体 CLI 并登录账号。阅读[安装指南](https://docs.dureai.dev/cn/install)，包括其中的 macOS 安全提示。
3. 在 Dure 中打开一个熟悉的 Git 项目。按下 **⌘N**，从一个小任务开始。

可以先试试这个请求：

```text
查找如何运行这个仓库的测试。
不要修改任何文件。
告诉我运行命令，以及哪些文件说明了这些命令。
```

### 使用前需要了解的边界

- **Worktree 分离文件，不隔离权限。** 它不是安全沙箱，不会隔离凭据、进程或网络访问。合并变更时仍可能发生冲突。
- **宿主必须保持运行。** 只要宿主进程和机器仍在运行，托管会话就可以独立于应用窗口继续工作。重启机器会结束原进程；恢复会创建替代进程。
- **审阅仍然必要。** 接受工作前，请检查智能体权限、代码变更和验证结果。账号切换和远程会话行为受到提供商与运行时能力的限制。

[会话与恢复](https://docs.dureai.dev/cn/session-model) · [SSH](https://docs.dureai.dev/cn/remote-and-ssh) · [工作安全指南](https://docs.dureai.dev/cn/current-limits)

## 源代码开放情况

**许可证：[MIT](../../LICENSE) · Copyright (c) 2026 Hebbian AI。**

Dure 自有源代码在本仓库中以 MIT 许可证提供。第三方组件保留各自的许可证和版权声明。

从源码构建请参阅[贡献指南](../../CONTRIBUTING.md#source-and-development)。应用可从[官网](https://www.dureai.dev/download/mac/)下载。

## 参与贡献

请阅读[贡献指南](../../CONTRIBUTING.md)和[行为准则](../../CODE_OF_CONDUCT.md)，或[报告问题、提出功能建议](https://github.com/hebbianai/dure/issues/new/choose)。安全漏洞请通过[安全政策](../../SECURITY.md)中的私密渠道报告。贡献与社区文档目前以英语提供。

---

<div align="center">

**你来掌舵。智能体协同工作。**

[下载 Dure](https://www.dureai.dev/download/mac/) · [阅读文档](https://docs.dureai.dev/cn/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
