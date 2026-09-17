export const ipc: Record<string, string> = {
	"ipc.dureRun.providerNotFound":
		"在执行主机上找不到提供商的可执行文件。请在该主机上安装所选提供商或修正 PATH，然后重试此请求。",
	"ipc.dureRun.providerNotExecutable":
		"提供商的可执行文件无法运行。请检查执行主机上的文件路径和执行权限，然后重试此请求。",
	"ipc.dureRun.providerLookupFailed":
		"Dure 无法检查执行主机上的提供商可执行文件。请检查路径和访问权限，然后重试此请求。",
	"ipc.dureRun.providerPathMissing":
		"执行主机上的 PATH 不可用。请恢复 PATH，然后重试此请求。",
	"ipc.browser.invalidResponse": "无法读取浏览器状态。请刷新 pane。",
	"ipc.browser.connectionChanged":
		"浏览器连接已更改。请重新连接并选择浏览器。",
	"ipc.browser.unavailable":
		"此浏览器已不可用。请重新连接并选择浏览器。",
	"ipc.browser.developmentRequired":
		"Pro Browser 需要兼容的开发版后端。请更新所选后端，然后重新连接。",
	"ipc.browser.runtimeRequired":
		"所选后端尚未安装浏览器运行时。请先在该后端安装运行时，再创建浏览器。",
	"ipc.browser.requestFailed": "浏览器请求未完成。请先检查状态，再重试。",
	"ipc.agentConversation.invalidResponse": "代理对话响应无效。",
	"ipc.agentConversation.requestFailed": "代理对话请求失败。",
	"ipc.dureBackend.generationChanged": "Dure 后端世代已变化。请使用同一请求重试。",
	"ipc.dureCoordinator.bindingMismatch": "协调者绑定响应与当前窗格不一致。",
	"ipc.dureDelegation.invalidResponse": "Dure 后端返回了无效的委派响应。",
	"ipc.dureDelegation.receiptMismatch": "Dure 后端返回了与请求不一致的委派回执。",
	"ipc.dureDelegation.requestFailed": "Dure 委派请求失败。",
	"ipc.dureDispatch.inspectionReceiptMismatch": "Dure Dispatch 检查回执与精确会话不一致。",
	"ipc.dureDispatch.rebindReceiptMismatch": "Dure Dispatch 重新绑定回执与日志所选会话不一致。",
	"ipc.dureOrchestration.apiResponseMismatch": "Dure 编排 API 响应与请求不一致。",
	"ipc.dureOrchestration.authorityGenerationChanged": "Dure 编排权限世代已变化，正在重新同步收件箱。",
	"ipc.dureOrchestration.invalidResponse": "Dure 编排响应格式不正确。",
	"ipc.dureOrchestration.receiptContractMismatch": "Dure 编排回执与契约不一致。",
	"ipc.dureOrchestration.requestFailed": "Dure 编排请求失败。",
	"ipc.dureOrchestration.responseMismatch": "Dure 编排响应与请求不一致。",
	"ipc.dureRun.invalidResponse": "Dure 后端返回了无效的 Run 响应。",
	"ipc.dureRun.stageFailed": "无法启动智能体 —— {stage} 步骤失败（{code}）。请重试。",
	"ipc.dureRun.promptUncertain": "智能体已启动，但没有确认收到提示（{code}）。再次发送前请查看它的终端。",
	"ipc.dureRun.receiptMismatch": "Dure 后端返回了与请求不一致的 Run 回执。",
	"ipc.dureRun.requestFailed": "对 Dure 后端的 Run 请求失败。",
};
