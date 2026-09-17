export const feedback: Record<string, string> = {
	"feedback.command": "フィードバックを送る",
	"feedback.dialog.title": "フィードバックを送る",
	"feedback.dialog.description":
		"バグを報告したり、アイデアを共有したり、その他のご意見をお寄せください。送信される内容は下でそのまま確認できます。",
	"feedback.dialog.notice.title": "含まれる内容",
	"feedback.dialog.notice.withScreenshot":
		"入力したメッセージ、下記の6つの環境情報、任意の連絡先、そして送信頻度の制限にのみ使う端末ごとのランダムなトークンが送信されます。これらの項目にターミナルの内容、コード、認証情報が含まれることはありません。スクリーンショットは別です。ターミナルの出力も含めて、このウィンドウがそのまま送信されます。サムネイルをクリックして実物大で確認してください。",
	"feedback.dialog.notice.withoutScreenshot":
		"入力したメッセージ、下記の6つの環境情報、任意の連絡先、そして送信頻度の制限にのみ使う端末ごとのランダムなトークンが送信されます。スクリーンショットは添付されないため、画面に映っていた内容は送信されません。これらの項目にターミナルの内容、コード、認証情報が含まれることはありません。",
	"feedback.dialog.kindLabel": "どのような内容ですか？",
	"feedback.dialog.kind.bug": "バグ",
	"feedback.dialog.kind.idea": "アイデア",
	"feedback.dialog.kind.other": "その他",
	"feedback.dialog.bodyLabel": "何が起きましたか？",
	"feedback.dialog.bodyPlaceholder":
		"何が起きたか、何を期待していたか、再現方法を記入してください。",
	"feedback.dialog.contactLabel": "連絡先（任意）",
	"feedback.dialog.contactPlaceholder": "返信用のメールアドレス",
	"feedback.dialog.screenshot.title": "スクリーンショット",
	"feedback.dialog.screenshot.expand": "実物大で表示",
	"feedback.dialog.screenshot.collapse": "実物大表示を閉じる",
	"feedback.dialog.screenshot.fullAlt":
		"このウィンドウのスクリーンショット（実物大）",
	"feedback.dialog.screenshot.included":
		"このウィンドウのスクリーンショットが添付されます。",
	"feedback.dialog.screenshot.removed": "スクリーンショットは含まれません。",
	"feedback.dialog.screenshot.permissionTitle": "画面収録の権限が必要です",
	"feedback.dialog.screenshot.permissionBody":
		"macOSの画面収録の権限が許可されていないため、Dureはスクリーンショットを取得できませんでした。システム設定 › プライバシーとセキュリティ › 画面収録でDureを有効にしてこのダイアログを開き直すか、スクリーンショットなしで報告を送信してください。",
	"feedback.dialog.screenshot.captureFailed":
		"スクリーンショットを取得できませんでした: {reason}",
	"feedback.dialog.environment.summary": "環境",
	"feedback.dialog.environment.os": "OS",
	"feedback.dialog.environment.arch": "アーキテクチャ",
	"feedback.dialog.environment.locale": "言語",
	"feedback.dialog.environment.window": "ウィンドウサイズ",
	"feedback.dialog.environment.app": "アプリビルド",
	"feedback.dialog.environment.channel": "チャンネル",
	"feedback.dialog.previewLabel": "送信内容の正確なプレビュー",
	"feedback.dialog.send": "送信",
	"feedback.dialog.sent": "送信済み",
	"feedback.dialog.sending": "送信中…",
	"feedback.dialog.retry": "再試行",
	"feedback.dialog.copyReport": "レポートをコピー",
	"feedback.dialog.copySuccess": "フィードバックレポートをコピーしました。",
	"feedback.dialog.copyFailed":
		"フィードバックレポートをコピーできませんでした: {error}",
	"feedback.dialog.sentNotice": "送信しました — 参照番号 {reference}。",
	"feedback.dialog.error.rejected":
		"Dureはこの報告を受け付けられませんでした: {message}",
	"feedback.dialog.error.rateLimited":
		"この端末から最近多くの報告が送られています。しばらくしてから再度お試しください。",
	"feedback.dialog.error.temporary":
		"フィードバックサービスが一時的に利用できません。入力内容はそのまま残っています — しばらくしてから再度お試しください。",
	"feedback.dialog.error.network":
		"フィードバックサービスに接続できませんでした。接続を確認して再度お試しください。",
	"feedback.dialog.error.attachmentTooLarge":
		"スクリーンショットのサイズが大きすぎて送信できません。",
	"feedback.dialog.sendWithoutScreenshot": "スクリーンショットなしで送信",
};
