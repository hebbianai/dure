export const ipcEnglishTranslations: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"Provider executable not found on the execution host. Install the selected provider there or fix PATH, then retry this request.",
	"ipc.dureRun.providerNotExecutable":
		"The provider executable cannot run. Check its path and execute permissions on the execution host, then retry this request.",
	"ipc.dureRun.providerLookupFailed":
		"Dure could not inspect the provider executable on the execution host. Check path and access permissions, then retry this request.",
	"ipc.dureRun.providerPathMissing":
		"PATH is unavailable on the execution host. Restore PATH, then retry this request.",
	"ipc.browser.invalidResponse":
		"Browser state could not be read. Refresh the pane.",
	"ipc.browser.connectionChanged":
		"The browser connection changed. Reconnect to choose a browser.",
	"ipc.browser.unavailable":
		"This browser is no longer available. Reconnect to choose a browser.",
	"ipc.browser.developmentRequired":
		"Pro Browser requires a compatible development backend. Update the selected backend, then reconnect.",
	"ipc.browser.runtimeRequired":
		"The browser runtime is missing on the selected backend. Install it there before creating a browser.",
	"ipc.browser.requestFailed":
		"The browser request did not finish. Check its status before trying again.",
	"ipc.agentConversation.invalidResponse": "The agent conversation response is invalid.",
	"ipc.agentConversation.requestFailed": "The agent conversation request failed.",
	"ipc.agentConversation.deliveryUnconfirmed": "Message delivery could not be confirmed. Check the conversation before sending again.",
	"ipc.dureBackend.generationChanged": "The Dure backend generation has changed. Retry with the same request.",
	"ipc.dureCoordinator.bindingMismatch": "The coordinator binding response does not match the current pane.",
	"ipc.dureDelegation.invalidResponse": "The Dure backend returned an invalid delegation response.",
	"ipc.dureDelegation.receiptMismatch": "The Dure backend returned a delegation receipt that does not match the request.",
	"ipc.dureDelegation.requestFailed": "The Dure delegation request failed.",
	"ipc.dureDispatch.inspectionReceiptMismatch": "The Dure Dispatch inspection receipt does not match the exact Session.",
	"ipc.dureDispatch.rebindReceiptMismatch": "The Dure Dispatch rebind receipt does not match the journal-selected Sessions.",
	"ipc.dureOrchestration.apiResponseMismatch": "The Dure orchestration API response does not match the request.",
	"ipc.dureOrchestration.authorityGenerationChanged": "The Dure orchestration authority generation has changed; resynchronizing the Inbox.",
	"ipc.dureOrchestration.invalidResponse": "The Dure orchestration response format is invalid.",
	"ipc.dureOrchestration.receiptContractMismatch": "The Dure orchestration receipt does not match the contract.",
	"ipc.dureOrchestration.requestFailed": "The Dure orchestration request failed.",
	"ipc.dureOrchestration.responseMismatch": "The Dure orchestration response does not match the request.",
	"ipc.dureRun.invalidResponse": "The Dure backend returned an invalid Run response.",
	"ipc.dureRun.stageFailed": "The agent could not start — the {stage} step failed ({code}). Try again.",
	"ipc.dureRun.promptUncertain": "The agent started, but it never confirmed the prompt ({code}). Check its terminal before sending the request again.",
	"ipc.dureRun.receiptMismatch": "The Dure backend returned a Run receipt that does not match the request.",
	"ipc.dureRun.requestFailed": "The Dure backend Run request failed.",
};
