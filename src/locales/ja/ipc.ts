export const ipc: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"実行ホストでプロバイダーの実行ファイルが見つかりません。選択したプロバイダーをそのホストにインストールするか PATH を修正してから、このリクエストを再試行してください。",
	"ipc.dureRun.providerNotExecutable":
		"プロバイダーの実行ファイルを実行できません。実行ホストのパスと実行権限を確認してから、このリクエストを再試行してください。",
	"ipc.dureRun.providerLookupFailed":
		"実行ホストでプロバイダーの実行ファイルを確認できませんでした。パスとアクセス権限を確認してから、このリクエストを再試行してください。",
	"ipc.dureRun.providerPathMissing":
		"実行ホストの PATH が利用できません。PATH を復元してから、このリクエストを再試行してください。",
	"ipc.browser.invalidResponse":
		"ブラウザーの状態を読み取れませんでした。paneを更新してください。",
	"ipc.browser.connectionChanged":
		"ブラウザーの接続が変更されました。再接続してブラウザーを選択してください。",
	"ipc.browser.unavailable":
		"このブラウザーは利用できなくなりました。再接続してブラウザーを選択してください。",
	"ipc.browser.developmentRequired": "Browserを使うには、選択したサーバーを更新して再接続してください。",
	"ipc.browser.runtimeRequired": "このサーバーでBrowserを使うには、ブラウザーのランタイムをダウンロードしてください。",
	"ipc.browser.requestFailed":
		"ブラウザーのリクエストが完了しませんでした。再試行する前に状態を確認してください。",
	"ipc.agentConversation.invalidResponse": "エージェント会話の応答が正しくありません。",
	"ipc.agentConversation.requestFailed": "エージェント会話のリクエストに失敗しました。",
	"ipc.agentConversation.deliveryUnconfirmed": "メッセージの送信を確認できませんでした。再送信する前に会話を確認してください。",
	"ipc.dureBackend.generationChanged": "Dureバックエンドの世代が変更されました。同じリクエストで再試行してください。",
	"ipc.dureCoordinator.bindingMismatch": "コーディネーターバインディングの応答が現在のペインと一致しません。",
	"ipc.dureDelegation.invalidResponse": "Dureバックエンドが無効な委任応答を返しました。",
	"ipc.dureDelegation.receiptMismatch": "Dureバックエンドがリクエストと一致しない委任レシートを返しました。",
	"ipc.dureDelegation.requestFailed": "Dureの委任リクエストに失敗しました。",
	"ipc.dureDispatch.inspectionReceiptMismatch": "Dure Dispatchの検査レシートが正確なセッションと一致しません。",
	"ipc.dureDispatch.rebindReceiptMismatch": "Dure Dispatchの再バインドレシートがジャーナルで選択されたセッションと一致しません。",
	"ipc.dureOrchestration.apiResponseMismatch": "DureオーケストレーションAPIの応答がリクエストと一致しません。",
	"ipc.dureOrchestration.authorityGenerationChanged": "Dureオーケストレーション権限の世代が変更されたため、受信トレイを再同期します。",
	"ipc.dureOrchestration.invalidResponse": "Dureオーケストレーションの応答形式が正しくありません。",
	"ipc.dureOrchestration.receiptContractMismatch": "Dureオーケストレーションのレシートが契約と一致しません。",
	"ipc.dureOrchestration.requestFailed": "Dureオーケストレーションのリクエストに失敗しました。",
	"ipc.dureOrchestration.responseMismatch": "Dureオーケストレーションの応答がリクエストと一致しません。",
	"ipc.dureRun.invalidResponse": "Dureバックエンドが無効なRun応答を返しました。",
	"ipc.dureRun.stageFailed": "エージェントを開始できませんでした — {stage} ステップが失敗しました ({code})。再試行してください。",
	"ipc.dureRun.promptUncertain": "エージェントは起動しましたが、プロンプトを受け取った確認がありません ({code})。再送する前にターミナルを確認してください。",
	"ipc.dureRun.receiptMismatch": "Dureバックエンドがリクエストと一致しないRunレシートを返しました。",
	"ipc.dureRun.requestFailed": "DureバックエンドへのRunリクエストに失敗しました。",
	"ipc.browser.installationFailed": "ブラウザーのインストールが完了しませんでした。接続を確認して、もう一度インストールしてください。",
	"ipc.browser.platformUnavailable": "Browserは現在Apple Silicon Macで利用できます。",
};
