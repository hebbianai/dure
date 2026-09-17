export const files: Record<string, string> = {
	"files.transfer.fileTooLarge": "“{name}”超过 50MB，无法传输",
	"files.transfer.duplicateName": "已存在同名文件：{name}",
	"files.transfer.totalTooLarge": "文件总大小不能超过 50MB",
	"files.transfer.infoUnreadable": "无法读取文件信息",
	"files.transfer.prepareInvalid": "文件准备结果无效",
	"files.transfer.tooManyFiles": "一次最多可传输 5 个文件",
	"files.transfer.remoteUpdateRequired":
		"请更新已连接服务器上的 Hmux，以便向此会话粘贴文件。",
	"files.transfer.sessionChanged":
		"上传期间会话或 SSH 连接发生了变化。请重新粘贴文件。",
	"files.transfer.sshRouteUnsupported":
		"此 SSH 命令的选项无法安全地用于文件粘贴。请通过 Dure 的 SSH 连接打开目标服务器。",
};
