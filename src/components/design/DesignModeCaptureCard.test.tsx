// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DesignModeCaptureCard } from "@/components/design/DesignModeCaptureCard";
import type { AgentTargetChoice } from "@/lib/design/designModeTarget";

const agent = (id: string, name = id) => ({ id, name, provider: "claude" });

function renderCard(choice: AgentTargetChoice, handlers = {}) {
	const props = {
		label: "button.save",
		choice,
		onSend: vi.fn(),
		onCopy: vi.fn(),
		onDismiss: vi.fn(),
		...handlers,
	};
	render(<DesignModeCaptureCard {...props} />);
	return props;
}

afterEach(cleanup);

// The app's Select (Radix) scrolls the focused option into view and tracks
// pointer capture; jsdom has neither.
beforeAll(() => {
	Element.prototype.scrollIntoView ??= () => {};
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.releasePointerCapture ??= () => {};
});

describe("DesignModeCaptureCard", () => {
	it("기본 대상으로 입력한다", () => {
		const props = renderCard({
			defaultId: "b",
			candidates: [agent("a"), agent("b")],
			reason: "last_input",
		});
		fireEvent.click(screen.getByRole("button", { name: /프롬프트에 입력/ }));
		expect(props.onSend).toHaveBeenCalledWith("b");
	});

	it("다른 에이전트를 골라 보낼 수 있다", async () => {
		const props = renderCard({
			defaultId: "a",
			candidates: [agent("a"), agent("b")],
			reason: "last_input",
		});
		fireEvent.keyDown(screen.getByRole("combobox", { name: /보낼 에이전트/ }), {
			key: "ArrowDown",
		});
		fireEvent.click(await screen.findByRole("option", { name: "b · claude" }));
		fireEvent.click(screen.getByRole("button", { name: /프롬프트에 입력/ }));
		expect(props.onSend).toHaveBeenCalledWith("b");
	});

	// 근거가 약한 선택을 강조하지 않으면 엉뚱한 pane으로 조용히 보내게 된다.
	it("최근 대화 기록이 없으면 대상 확인을 요청한다", () => {
		renderCard({
			defaultId: "a",
			candidates: [agent("a"), agent("b")],
			reason: "first_candidate",
		});
		expect(screen.getByText(/대상을 확인하세요/)).toBeTruthy();
	});

	it("최근 대화 기반이면 그렇게 알린다", () => {
		renderCard({
			defaultId: "a",
			candidates: [agent("a")],
			reason: "last_input",
		});
		expect(screen.getByText(/마지막으로 대화한 에이전트/)).toBeTruthy();
	});

	// 에이전트가 없다고 캡처를 버리면 사용자는 다시 집어야 한다.
	it("에이전트가 없으면 복사만 제안한다", () => {
		const props = renderCard({ candidates: [], reason: "none" });
		expect(
			screen.queryByRole("button", { name: /프롬프트에 입력/ }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /복사/ }));
		expect(props.onCopy).toHaveBeenCalledOnce();
	});

	// 제출까지 자동으로 될 것이라 오해하면 사용자가 요청을 덧붙이지 않는다.
	it("전송하지 않는다는 사실을 미리 알린다", () => {
		renderCard({
			defaultId: "a",
			candidates: [agent("a")],
			reason: "only_candidate",
		});
		expect(screen.getByText(/전송하지 않습니다/)).toBeTruthy();
	});

	it("닫기로 버릴 수 있다", () => {
		const props = renderCard({ candidates: [], reason: "none" });
		fireEvent.click(screen.getByRole("button", { name: /닫기/ }));
		expect(props.onDismiss).toHaveBeenCalledOnce();
	});
});

it("prevents repeated send, copy and dismissal while image delivery is pending", () => {
	const props = renderCard(
		{ defaultId: "a", candidates: [agent("a")], reason: "only_candidate" },
		{ busy: true, imageSrc: "data:image/png;base64,cG5n" },
	);
	expect(screen.getByRole("img").getAttribute("src")).toBe(
		"data:image/png;base64,cG5n",
	);
	for (const button of screen.getAllByRole("button")) {
		expect(button.hasAttribute("disabled")).toBe(true);
		fireEvent.click(button);
	}
	expect(screen.getByRole("combobox").hasAttribute("disabled")).toBe(true);
	expect(props.onSend).not.toHaveBeenCalled();
	expect(props.onCopy).not.toHaveBeenCalled();
	expect(props.onDismiss).not.toHaveBeenCalled();
});
