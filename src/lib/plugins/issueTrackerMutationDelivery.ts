/** The one placeholder a provider's terminal command template may carry. */
const ISSUE_TRACKER_ISSUE_ID_PLACEHOLDER = "{issue_id}";
const ISSUE_ID = /^[a-z][a-z0-9._-]{0,255}$/;
const TEMPLATE_TOKEN = /^[A-Za-z0-9._{}=/:@-]{1,128}$/;
const MAX_TEMPLATE_TOKENS = 16;

/** Renders a provider-declared terminal command for one issue. The host
 * validated the template when it loaded the plugin; this is the only command
 * line run in a shell on the user's behalf, so it is checked again at the
 * point of use and never joined from anything but bounded shell words. */
export function renderIssueTrackerTerminalCommand(
	template: readonly string[],
	issueId: string,
): string | null {
	if (!ISSUE_ID.test(issueId)) return null;
	if (template.length === 0 || template.length > MAX_TEMPLATE_TOKENS) {
		return null;
	}
	const placeholders = template.filter(
		(token) => token === ISSUE_TRACKER_ISSUE_ID_PLACEHOLDER,
	).length;
	if (placeholders !== 1) return null;
	if (!template.every((token) => TEMPLATE_TOKEN.test(token))) return null;
	return template
		.map((token) =>
			token === ISSUE_TRACKER_ISSUE_ID_PLACEHOLDER ? issueId : token,
		)
		.join(" ");
}
