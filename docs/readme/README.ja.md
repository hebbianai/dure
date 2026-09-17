<div align="center">

<a href="https://www.dureai.dev/">
  <img src="../../public/readme/dure-logo.png" alt="Dure" width="88" height="88" />
</a>

# Dure

### あなたが導く。<br>エージェントが共に働く。

AI コーディングエージェントのための **Agent Development Environment（ADE）**。<br>
プロジェクト、会話、ターミナル、コードの変更を、ひとつの macOS ワークスペースに。

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

## エージェントが増えても、導く場所はひとつ。

難しいのは、エージェントをもうひとつ起動することではありません。どのタスクに自分の判断が必要で、何が変わり、次に何をすべきかを把握することです。

Dure は、その仕事をひとつの場所にまとめます。Claude Code の隣に Codex と Pi を並べ、複数のプロジェクトや SSH ホストのセッションを追いかける。差分を読み、フィードバックを送り、次のタスクの方向を決める。

## 最初のタスクから最後のレビューまで

### 01 — 目標から始める

**⌘N** を押し、タスクを説明して、プロジェクトとプロバイダーを選びます。独立してファイルを編集するタスクには、専用の Git worktree とブランチを指定しましょう。GitHub の Issue で **Start** を選ぶと、内容が入力済みのタスクを開くこともできます。

### 02 — 注意を向ける場所を整える

ペインを分割し、タブを移動し、デスクトップを切り替えたり、セッションを独立したウィンドウで開いたりできます。Spaces ではローカルと SSH の作業を一緒に表示し、活動や変更の表示から確認が必要なタスクを見つけられます。

<table>
<tr>
<td width="50%">
<a href="https://docs.dureai.dev/jp/quickstart"><img src="../../public/readme/start-agent.png" alt="Command-N で開いた新規エージェント画面。タスク、プロジェクト、プロバイダー、専用 worktree の設定" width="460" /></a>
<br><sub>仕事を伝え、エージェントを選ぶ。</sub>
</td>
<td width="50%">
<a href="https://docs.dureai.dev/jp/spaces-and-panes"><img src="../../public/readme/pane-arrangement.png" alt="実行中のターミナルタブを Dure の Split Right 領域にドラッグする様子" width="460" /></a>
<br><sub>表示を動かし、作業の文脈はそのままに。</sub>
</td>
</tr>
</table>

### 03 — レビューして、導く

未コミットの変更や新規ファイルを含め、ローカルの変更を確認します。行コメントを追加し、エージェントにフィードバックとして送れます。作業を統合する前に、変更内容とテスト結果を確認してください。次の一手を決めるのは、あなたです。

[最初のエージェント →](https://docs.dureai.dev/jp/quickstart) &nbsp; [並列タスク →](https://docs.dureai.dev/jp/first-parallel-workflow) &nbsp; [レビューとフィードバック →](https://docs.dureai.dev/jp/review-and-feedback)

## エージェントの仕事を支えるワークスペース

| こんなときに | Dure が提供するもの |
| --- | --- |
| 独立したタスクを並行して進めたい | タスクごとに作業ファイルを分ける、専用の Git worktree とブランチ。 |
| 実行中の仕事を把握したい | 複数プロジェクトをまたぐ Spaces、分割ペイン、デスクトップ、独立ウィンドウ。 |
| アプリを閉じた後に戻りたい | 実行中の管理対象セッションへの再接続と、終了したプロセスのための別の復旧フロー。 |
| 複数のマシンで作業したい | ローカル作業と並べられる SSH プロジェクトとリモートターミナル。画像貼り付けとファイル転送にも対応。 |
| 既存のアカウントを使いたい | 対応プロバイダーでのエージェント別プロファイルと、プロバイダーが報告する使用量。 |
| 繰り返す仕事をつなぎたい | CLI 実行とスケジュール、CLI/MCP のメッセージ、判断リクエスト、完了報告。 |
| 自分に合った環境にしたい | テーマ、ターミナルの文字設定、7言語のインターフェース。 |

### いつものツール。いつものアカウント。

**Claude Code、Codex、Pi、Gemini CLI、OpenCode、Kimi Code** などのネイティブなコーディングエージェント CLI を使えます。Dure はワークスペースであり、モデルやプロバイダーのサブスクリプションではありません。プロバイダーの契約と利用料金は別途必要です。

ターミナル対応、会話履歴、チャット表示、アカウント機能はプロバイダーによって異なります。[プロバイダー別の対応を確認 →](https://docs.dureai.dev/jp/providers)

## Mac で始める

1. Apple Silicon Mac で **[macOS 版 Dure をダウンロード](https://www.dureai.dev/download/mac/)**します。ディスクイメージを開き、アプリを**アプリケーション**フォルダに移動します。
2. 対応するコーディングエージェント CLI をひとつ以上インストールし、ログインします。macOS のセキュリティ案内を含む[インストールガイド](https://docs.dureai.dev/jp/install)を確認してください。
3. Dure で使い慣れた Git プロジェクトを開きます。**⌘N** を押して、小さなタスクから始めましょう。

最初は、こんな依頼を試してみてください。

```text
このリポジトリのテストを実行する方法を調べてください。
ファイルは変更しないでください。
実行コマンドと、その説明があるファイルを教えてください。
```

### 知っておきたい境界

- **Worktree が分けるのはファイルであり、権限ではありません。** セキュリティサンドボックスではなく、認証情報、プロセス、ネットワークアクセスは隔離されません。変更を統合するときに競合することもあります。
- **ホストが動いている必要があります。** ホストプロセスとマシンが稼働している間、管理対象セッションはアプリのウィンドウと独立して実行を続けられます。再起動すると元のプロセスは終了し、復旧では代わりのプロセスを作成します。
- **レビューは引き続き必要です。** 作業を受け入れる前に、エージェントの権限、変更内容、検証結果を確認してください。アカウント切り替えとリモートセッションの動作には、プロバイダーやランタイムごとの制約があります。

[セッションと復旧](https://docs.dureai.dev/jp/session-model) · [SSH](https://docs.dureai.dev/jp/remote-and-ssh) · [安全に作業するために](https://docs.dureai.dev/jp/current-limits)

## ソースコードの公開について

**ライセンス：[MIT](../../LICENSE) · Copyright (c) 2026 Hebbian AI。**

Dure 独自のソースコードは、このリポジトリで MIT ライセンスにより公開されています。サードパーティのコンポーネントには、それぞれのライセンスと著作権表示が引き続き適用されます。

ソースからのビルド手順は[貢献ガイド](../../CONTRIBUTING.md#source-and-development)をご覧ください。アプリは[ウェブサイト](https://www.dureai.dev/download/mac/)からダウンロードできます。

## 貢献する

[貢献ガイド](../../CONTRIBUTING.md)と[行動規範](../../CODE_OF_CONDUCT.md)をご確認ください。[不具合の報告や機能の提案](https://github.com/hebbianai/dure/issues/new/choose)も歓迎します。脆弱性は[セキュリティポリシー](../../SECURITY.md)に記載された非公開の窓口へご報告ください。貢献・運営に関する文書は現在英語で提供しています。

---

<div align="center">

**あなたが導く。エージェントが共に働く。**

[Dure をダウンロード](https://www.dureai.dev/download/mac/) · [ドキュメントを読む](https://docs.dureai.dev/jp/introduction) · [dureai.dev](https://www.dureai.dev/) · [X](https://x.com/hebbianai_) · [Discord](https://discord.gg/aTuRV6DXhb)

</div>
