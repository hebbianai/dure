<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### あなたが導く。<br>エージェントが共に働く。

AI コーディングエージェントのための**オープンソース・ワークスペース**。<br>
専用 worktree とコードレビューを使い、複数のプロジェクトや SSH ホストの Claude Code、Codex、Pi をまとめて指揮できます。

**[macOS 版をダウンロード](https://www.dureai.dev/download/mac/)** &nbsp;·&nbsp; [ウェブサイト](https://www.dureai.dev/) &nbsp;·&nbsp; [ドキュメント](https://docs.dureai.dev/jp/introduction) &nbsp;·&nbsp; [X](https://x.com/hebbianai_) &nbsp;·&nbsp; [Discord](https://discord.gg/aTuRV6DXhb)

<sub>Apple Silicon · 使い慣れたコーディングエージェント CLI とアカウントをそのまま</sub>

[English](../../README.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · **日本語** · [Español](README.es.md) · [Français](README.fr.md) · [Português](README.pt.md)

<br>

<a href="https://www.dureai.dev/#hero-film">
  <img src="../../public/readme/workspace-tour.webp" alt="Claude Code、Codex、Pi とシェルを6つのペインに配置し、Spaces にプロジェクトとセッションを表示した Dure" width="960" />
</a>

**[▶ 29秒で見る Dure](https://www.dureai.dev/#hero-film)** · [MP4 をダウンロード](https://raw.githubusercontent.com/hebbianai/dure/main/public/readme/workspace-tour.mp4)

<sub>サンプルプロジェクトで実際のコーディングエージェント CLI を動かしたネイティブアプリの映像です。<br>GitHub の Issue 一覧はデモデータです。開発ビルドで収録しているため、ダウンロード版とは表示が異なる場合があります。</sub>

</div>

## 仕事を進める四つの方法

### エージェントは並列に、worktree は個別に

**⌘N** または GitHub Issue からエージェントを開始します。プロジェクトとプロバイダーを選び、独立してファイルを変更するタスクには専用の Git worktree とブランチを割り当てられます。

[並列タスクを始める →](https://docs.dureai.dev/jp/first-parallel-workflow)

<a href="https://docs.dureai.dev/jp/first-parallel-workflow">
  <img src="../../public/readme/start-agent.png" alt="タスク、プロバイダー、専用 worktree の設定を選びます。" width="880" />
</a>

<sub>タスク、プロバイダー、専用 worktree の設定を選びます。</sub>

### ローカルと SSH の仕事をまとめる Spaces

プロジェクトとセッションを Spaces で整理します。ペインの分割、タブの移動、別ウィンドウの表示で、ローカルと SSH の仕事を一緒に確認できます。

[Spaces とペイン →](https://docs.dureai.dev/jp/spaces-and-panes) · [SSH の設定](https://docs.dureai.dev/jp/remote-and-ssh)

<a href="https://docs.dureai.dev/jp/spaces-and-panes">
  <img src="../../public/readme/pane-arrangement.png" alt="サンプルプロジェクトで実行中のエージェントのペインを配置する様子です。" width="880" />
</a>

<sub>サンプルプロジェクトで実行中のエージェントのペインを配置する様子です。</sub>

### 会話の隣でコードをレビュー

未コミットの変更や新規ファイルを含むローカル diff を確認します。ファイルや行にコメントを付け、紐づくエージェントへ送り、変更を統合する前に次の修正をレビューできます。

[レビューとフィードバック →](https://docs.dureai.dev/jp/review-and-feedback)

<a href="https://docs.dureai.dev/jp/review-and-feedback">
  <img src="../../docs/public/images/diff-review.png" alt="レビューコメントを付ける前にサンプルプロジェクトの diff を確認します。" width="880" />
</a>

<sub>レビューコメントを付ける前にサンプルプロジェクトの diff を確認します。</sub>

### CLI 実行・スケジュールとエージェント連携

Dure CLI でタスクを実行し、繰り返す仕事をスケジュールできます。CLI と MCP の統合を通じて、人とエージェントが進捗メッセージ、判断の依頼、完了報告をやり取りできます。

```sh
dure run --provider codex --worktree readme-review \
  "Review the README against the code. Do not change files."
dure ls
```

[CLI 実行とスケジュール →](https://docs.dureai.dev/jp/cli-and-automation) · [メッセージと判断](https://docs.dureai.dev/jp/orchestration)

## 対応エージェント

**Claude Code · Codex · Pi · OpenCode · Gemini CLI · Kimi Code**

インストール済みのコーディングエージェント CLI と既存のプロバイダーアカウントを利用できます。モデルへのアクセス、サブスクリプション、利用料金は各プロバイダーが管理します。

Claude Code、Codex、OpenCode、Pi は、インストールされたランタイムが対応している場合に構造化チャットを利用できます。ターミナル、履歴、再開、アカウントの機能はプロバイダーによって異なります。 [プロバイダー別の機能を確認 →](https://docs.dureai.dev/jp/providers)

## インストールとプラットフォームの状況

| プラットフォーム | 現在の提供範囲 |
| --- | --- |
| macOS · Apple Silicon | [公式ダウンロード](https://www.dureai.dev/download/mac/) |
| Windows | ソース公開済み。ネイティブデスクトップの検証と公開インストーラーは準備中です。 |
| Linux | ソース公開済み。ネイティブデスクトップの検証と公開インストーラーは準備中です。 |
| iOS | ソース公開済み。実機検証と公式配布は準備中です。 |
| Android | ソース公開済み。実機検証と公式配布は準備中です。 |

ソースからのビルドと検証範囲は[プラットフォーム別の開発ガイド](../../CONTRIBUTING.md#platforms)をご覧ください。

### Mac で始める

1. Apple Silicon Mac で **[macOS 版 Dure をダウンロード](https://www.dureai.dev/download/mac/)**します。ディスクイメージを開き、アプリを**アプリケーション**フォルダに移動します。
2. 対応するコーディングエージェント CLI をひとつ以上インストールし、ログインします。macOS のセキュリティ案内を含む[インストールガイド](https://docs.dureai.dev/jp/install)を確認してください。
3. Dure で使い慣れた Git プロジェクトを開きます。**⌘N** を押して、小さなタスクから始めましょう。

<details>
<summary>知っておきたい境界</summary>

- **Worktree が分けるのはファイルであり、権限ではありません。** セキュリティサンドボックスではなく、認証情報、プロセス、ネットワークアクセスは隔離されません。変更を統合するときに競合することもあります。
- **ホストが動いている必要があります。** ホストプロセスとマシンが稼働している間、管理対象セッションはアプリのウィンドウと独立して実行を続けられます。再起動すると元のプロセスは終了し、復旧では代わりのプロセスを作成します。
- **レビューは引き続き必要です。** 作業を受け入れる前に、エージェントの権限、変更内容、検証結果を確認してください。アカウント切り替えとリモートセッションの動作には、プロバイダーやランタイムごとの制約があります。

[セッションと復旧](https://docs.dureai.dev/jp/session-model) · [SSH](https://docs.dureai.dev/jp/remote-and-ssh) · [安全に作業するために](https://docs.dureai.dev/jp/current-limits)

</details>

## オープンソースの範囲

Copyright (C) 2026 [Hebbian AI](../../COPYRIGHT).

このリポジトリで公開するデスクトップ、モバイル、ランタイム（Hmux を含む）、CLI、サービスの独自コードは [GNU GPL バージョン 3 のみ（GPL-3.0-only）](../../LICENSE)で提供されます。サードパーティのライセンスと表示は維持され、各ライセンスに従って使用、変更、再配布できます。対象となるバイナリを配布する場合は、GPLv3 の定める方法で対応するソースコード（Corresponding Source）を提供する必要があります。以前に MIT で公開されたバージョンには、引き続きその条件が適用されます。

Dure の名称、ロゴ、アプリアイコン、およびコミュニティビルドと Hebbian AI の公式ビルドの区別は [TRADEMARK.md](../../TRADEMARK.md) に記載しています。

ソースのライセンスに運営サービスへのアクセス権は含まれません。署名鍵、デプロイ用の認証情報、機密の事業・運営記録は非公開です。

## 貢献する

[貢献ガイド](../../CONTRIBUTING.md)と[行動規範](../../CODE_OF_CONDUCT.md)をご確認ください。[不具合の報告や機能の提案](https://github.com/hebbianai/dure/issues/new/choose)も歓迎します。脆弱性は[セキュリティポリシー](../../SECURITY.md)に記載された非公開の窓口へご報告ください。貢献・運営に関する文書は現在英語で提供しています。

- **リリースノート:** [GitHub Releases](https://github.com/hebbianai/hebbian-releases/releases)
- **プライバシーとテレメトリー:** [プライバシーとテレメトリー](https://docs.dureai.dev/jp/privacy-and-telemetry)
- **コミュニティ:** [Discord](https://discord.gg/aTuRV6DXhb)
- **最新情報:** [X · @hebbianai_](https://x.com/hebbianai_)

---

<div align="center">

**あなたが導く。エージェントが共に働く。**

[Dure をダウンロード](https://www.dureai.dev/download/mac/) · [ドキュメントを読む](https://docs.dureai.dev/jp/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
