export const feedbackEnglishTranslations: Record<string, string> = {
	"feedback.command": "Send feedback",
	"feedback.dialog.title": "Send feedback",
	"feedback.dialog.description":
		"Report a bug, share an idea, or tell us something else. Review exactly what will be sent below.",
	"feedback.dialog.notice.title": "What's included",
	"feedback.dialog.notice.withScreenshot":
		"Your message, the six environment values below, an optional contact, and a random per-install rate-limiting token. Those fields never carry terminal content, code, or credentials. The screenshot does: it sends this window exactly as it looked — terminal output included. Click the thumbnail to check it at full size.",
	"feedback.dialog.notice.withoutScreenshot":
		"Your message, the six environment values below, an optional contact, and a random per-install rate-limiting token. No screenshot is attached, so nothing that was on screen is sent. Those fields never carry terminal content, code, or credentials.",
	"feedback.dialog.kindLabel": "What is this about?",
	"feedback.dialog.kind.bug": "Bug",
	"feedback.dialog.kind.idea": "Idea",
	"feedback.dialog.kind.other": "Other",
	"feedback.dialog.bodyLabel": "What happened?",
	"feedback.dialog.bodyPlaceholder":
		"Describe what happened, what you expected, and how to reproduce it.",
	"feedback.dialog.contactLabel": "Contact (optional)",
	"feedback.dialog.contactPlaceholder": "Email, so we can follow up",
	"feedback.dialog.screenshot.title": "Screenshot",
	"feedback.dialog.screenshot.expand": "View full size",
	"feedback.dialog.screenshot.collapse": "Hide full size",
	"feedback.dialog.screenshot.fullAlt": "Screenshot of this window, full size",
	"feedback.dialog.screenshot.included":
		"A screenshot of this window is attached.",
	"feedback.dialog.screenshot.removed": "Screenshot not included.",
	"feedback.dialog.screenshot.permissionTitle":
		"Screen Recording permission needed",
	"feedback.dialog.screenshot.permissionBody":
		"Dure couldn't capture a screenshot because macOS Screen Recording permission isn't granted. Open System Settings › Privacy & Security › Screen Recording, enable Dure, and reopen this dialog — or send your report without one.",
	"feedback.dialog.screenshot.captureFailed":
		"Screenshot couldn't be captured: {reason}",
	"feedback.dialog.environment.summary": "Environment",
	"feedback.dialog.environment.os": "OS",
	"feedback.dialog.environment.arch": "Architecture",
	"feedback.dialog.environment.locale": "Language",
	"feedback.dialog.environment.window": "Window",
	"feedback.dialog.environment.app": "App build",
	"feedback.dialog.environment.channel": "Channel",
	"feedback.dialog.previewLabel": "Exact report preview",
	"feedback.dialog.send": "Send",
	"feedback.dialog.sent": "Sent",
	"feedback.dialog.sending": "Sending…",
	"feedback.dialog.retry": "Retry",
	"feedback.dialog.copyReport": "Copy report",
	"feedback.dialog.copySuccess": "Feedback report copied.",
	"feedback.dialog.copyFailed": "Couldn't copy the feedback report: {error}",
	"feedback.dialog.sentNotice": "Sent — reference {reference}.",
	"feedback.dialog.error.rejected":
		"Dure couldn't accept this report: {message}",
	"feedback.dialog.error.rateLimited":
		"Too many reports from this device recently. Try again in a bit.",
	"feedback.dialog.error.temporary":
		"The feedback service is temporarily unavailable. Your report is still here — try again shortly.",
	"feedback.dialog.error.network":
		"Couldn't reach the feedback service. Check your connection and try again.",
	"feedback.dialog.error.attachmentTooLarge":
		"The screenshot is too large to send.",
	"feedback.dialog.sendWithoutScreenshot": "Send without screenshot",
	"feedback.dialog.error.rateLimitedWait":
		"Too many reports from this device or network. You can retry in {seconds} seconds. Your report is still here.",
	"feedback.dialog.error.rateLimitedReady":
		"You can retry now. Your report is still here.",
};
