export const files: Record<string, string> = {
	"files.transfer.fileTooLarge": "'{name}' は 50MB を超えるため転送できません",
	"files.transfer.duplicateName": "同じ名前のファイルがすでに存在します: {name}",
	"files.transfer.totalTooLarge": "ファイルの合計サイズは 50MB を超えられません",
	"files.transfer.infoUnreadable": "ファイル情報を読み取れません",
	"files.transfer.prepareInvalid": "ファイルの準備結果が無効です",
	"files.transfer.tooManyFiles": "一度に転送できるファイルは最大 5 個です",
	"files.transfer.remoteUpdateRequired":
		"このセッションにファイルを貼り付けるには、接続先サーバーの Hmux を更新してください。",
	"files.transfer.sessionChanged":
		"アップロード中にセッションまたは SSH 接続が変わりました。ファイルをもう一度貼り付けてください。",
	"files.transfer.sshRouteUnsupported":
		"この SSH コマンドのオプションは、ファイルの貼り付けで安全に再利用できません。Dure の SSH 接続で接続先を開いてください。",
};
