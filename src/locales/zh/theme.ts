export const theme: Record<string, string> = {
	"theme.validation.invalidId": "id 必须是小写字母 / 数字 / 短横线，且不超过 64 个字符",
	"theme.validation.invalidName": "name 缺失或过长",
	"theme.validation.terminalPaletteMissing": "缺少 terminal 调色板",
	"theme.validation.terminalSlotFormat": "terminal.{slot} 不是 #rrggbb 格式",
	"theme.validation.uiTokenFormat": "ui.{key} 不是 #rrggbb 格式",
	"theme.validation.uiTokenUnknown": "ui.{key} 不是允许的 token",
	"theme.validation.uiNotObject": "ui 必须是一个对象",
	"theme.validation.notObject": "主题必须是一个 JSON 对象",
	"theme.validation.invalidAppearance": "appearance 必须是 \"dark\" 或 \"light\"",
};
