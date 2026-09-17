/**
 * 캡처를 에이전트에게 보낼 텍스트로 만든다 (Design Mode).
 *
 * 형식을 순수 함수로 둔 이유: 이 텍스트가 A단계(클립보드)와 B단계(에이전트 PTY
 * 타이핑) 양쪽에서 같아야 하고, 무엇이 들어가는지를 테스트로 고정해야 한다.
 *
 * 사용자가 쓸 자리를 **맨 앞에** 비워 둔다. 캡처가 먼저 오면 사용자는 긴 블록을
 * 지나쳐 내려가서 타이핑해야 한다.
 *
 * Copy runs at user-action time in the app runtime, so every label the user
 * reads goes through t() here — the Korean literals are lookup keys.
 */
import type { CapturedElement } from "@/lib/design/designModeCapture";
import { t } from "@/lib/i18n";

export function formatCapturedElement(captured: CapturedElement): string {
	const lines: string[] = [];
	lines.push(t("design.prompt.requestPlaceholder"));
	lines.push("");
	// 사람이 이 요소를 부르는 이름을 먼저 준다 — 태그·클래스보다 그게 지시에
	// 쓰이는 이름이다.
	const name = captured.accessibility.accessibleName;
	lines.push(`${t("design.prompt.element")}: ${captured.label}${name ? ` — "${name}"` : ""}`);
	if (captured.component) lines.push(`${t("design.prompt.component")}: ${captured.component}`);
	if (captured.source) lines.push(`${t("design.prompt.source")}: ${captured.source}`);
	lines.push(`${t("design.prompt.selector")}: ${captured.selector}`);
	if (captured.ancestors.length > 0) {
		lines.push(`${t("common.location")}: ${captured.ancestors.join(" > ")}`);
	}
	if (captured.accessibility.role) {
		lines.push(`${t("design.prompt.role")}: ${captured.accessibility.role}`);
	}
	lines.push(
		`${t("design.prompt.size")}: ${captured.rect.width}×${captured.rect.height} @ ${t("design.prompt.viewport")}(${captured.rect.x}, ${captured.rect.y})`,
	);
	if (captured.page) {
		lines.push(`${t("design.prompt.page")}: ${captured.page.url}`);
	}
	if (captured.screenshotPath) {
		// 에이전트가 파일을 읽을 수 있게 경로로 준다 — 이미지를 프롬프트 텍스트에
		// 인라인할 수는 없다.
		lines.push(`${t("design.prompt.screenshot")}: ${captured.screenshotPath}`);
	}
	if (captured.selectedText) {
		lines.push(`${t("design.prompt.selectedText")}: "${captured.selectedText}"`);
	}
	if (captured.nearby.length > 0) {
		// 같은 모양이 여럿일 때 어느 것인지를 사람 말로 좁힌다.
		lines.push(
			`${t("design.prompt.nearbyItems")}: ${captured.nearby.map((text) => `"${text}"`).join(", ")}`,
		);
	}
	lines.push("");
	lines.push("HTML:");
	lines.push("```html");
	lines.push(captured.html);
	lines.push("```");
	if (captured.htmlElided) {
		lines.push(t("design.prompt.childrenElided"));
	}
	const cssEntries = Object.entries(captured.css);
	if (cssEntries.length > 0) {
		lines.push("");
		lines.push(`${t("design.prompt.appliedCss")}:`);
		lines.push("```css");
		for (const [property, value] of cssEntries) {
			lines.push(`${property}: ${value};`);
		}
		lines.push("```");
	}
	return lines.join("\n");
}

/** "redesign this" preset: the agent writes a mockup
 *  file instead of editing product code, so the proposal renders in the mockup
 *  pane for review and token checks. Wraps the ordinary capture payload. */
export function formatRedesignMockupPrompt(captureText: string): string {
	return [
		t("design.prompt.mockupRedesignInstructions"),
		"",
		captureText,
	].join("\n");
}
