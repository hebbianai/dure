// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAddMenuButton } from "@/components/spaces/DesktopAddMenuButton";
import { onQuickDispatchRequest } from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { openBrowserPanelOnDesktop } from "@/lib/workspace/dock/openBrowserPanel";
import {
	HOVER_MENU_CLOSE_DELAY_MS,
	HOVER_MENU_OPEN_DELAY_MS,
} from "@/lib/ui/hoverOpenMenu";

import { openMobileSimulatorPanelOnDesktop } from "@/lib/workspace/dock/openMobileSimulatorPanel";
vi.mock("@/lib/workspace/dock/openMobileSimulatorPanel", () => ({ openMobileSimulatorPanelOnDesktop: vi.fn() }));

const DESKTOP = { id: "d1", name: "desktop 1" } as const;

vi.mock("@/lib/workspace/dock/openBrowserPanel", () => ({
	openBrowserPanelOnDesktop: vi.fn(),
}));

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function openMenu() {
	fireEvent.pointerDown(
		screen.getByRole("button", { name: "desktop 1에 추가" }),
		{
			button: 0,
			ctrlKey: false,
		},
	);
}

describe("DesktopAddMenuButton", () => {
	it("keeps an accessible name", () => {
		render(
			<DesktopAddMenuButton
				desktop={DESKTOP}
				onAddAgent={vi.fn()}
				onAddTerminal={vi.fn()}
			/>,
		);
		const trigger = screen.getByRole("button", { name: "desktop 1에 추가" });

		expect(trigger.getAttribute("aria-label")).toBe("desktop 1에 추가");
	});

	it("opens below the trigger with the right edges aligned", async () => {
		render(
			<DesktopAddMenuButton
				desktop={DESKTOP}
				onAddAgent={vi.fn()}
				onAddTerminal={vi.fn()}
			/>,
		);
		fireEvent.pointerDown(
			screen.getByRole("button", { name: "desktop 1에 추가" }),
			{ button: 0, ctrlKey: false },
		);

    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("data-side")).toBe("bottom");
    expect(menu.getAttribute("data-align")).toBe("start");
	});

	it('기본 트리거는 hover 전용이고 triggerClassName=""이면 항상 보인다', () => {
		const props = { onAddAgent: vi.fn(), onAddTerminal: vi.fn() };
		const { rerender } = render(
			<DesktopAddMenuButton desktop={DESKTOP} {...props} />,
		);
		expect(
			screen.getByRole("button", { name: "desktop 1에 추가" }).className,
		).toContain("opacity-0");

		rerender(
			<DesktopAddMenuButton desktop={DESKTOP} {...props} triggerClassName="" />,
		);
		expect(
			screen.getByRole("button", { name: "desktop 1에 추가" }).className,
		).not.toContain("opacity-0");
	});

	/** ⌘N의 작성 화면을 포인터로도 연다(사용자 요청) — 메뉴는 오버레이를 직접
	 *  마운트하지 않고 요청만 보낸다. */
	it("⌘N의 새 에이전트 요청을 같은 메뉴에서 연다", async () => {
		const requested = vi.fn();
		const stop = onQuickDispatchRequest(requested);
		render(
			<DesktopAddMenuButton
				desktop={DESKTOP}
				onAddAgent={vi.fn()}
				onAddTerminal={vi.fn()}
			/>,
		);

		openMenu();
		const item = await screen.findByRole("menuitem", {
			name: /새 에이전트 요청/,
		});
		// 단축키는 라벨 안 괄호가 아니라 오른쪽 키캡 슬롯이다 — 라벨에 넣으면
		// 패널 오른쪽이 비좁아진다(2026-08-31 사용자 제보).
		expect(screen.getByText("⌘").tagName).toBe("KBD");
		expect(screen.getByText("N").tagName).toBe("KBD");

		fireEvent.click(item);

		expect(requested).toHaveBeenCalledTimes(1);
		stop();
	});

	it("opens agents, terminals, and the browser on the menu's desktop", async () => {
		const onAddAgent = vi.fn();
		const onAddTerminal = vi.fn();
		render(
			<DesktopAddMenuButton
				desktop={DESKTOP}
				onAddAgent={onAddAgent}
				onAddTerminal={onAddTerminal}
			/>,
		);

		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "새 에이전트 시작…" }),
		);
		expect(onAddAgent).toHaveBeenCalledWith("d1");

		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "터미널 열기" }),
		);
		expect(onAddTerminal).toHaveBeenCalledWith("d1");

		openMenu();
		fireEvent.click(
			await screen.findByRole("menuitem", { name: "브라우저 열기" }),
		);
		expect(openBrowserPanelOnDesktop).toHaveBeenCalledExactlyOnceWith("d1");
		expect(screen.queryByRole("menu")).toBeNull();
		openMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: "모바일 시뮬레이터" }));
		expect(openMobileSimulatorPanelOnDesktop).toHaveBeenCalledExactlyOnceWith("d1");
	});

	/** hover로 열어 둔 메뉴를 클릭하면 닫히던 문제(2026-08-31 사용자 제보):
	 *  Radix 트리거의 토글이 hover-open과 부딪혀, 쓰려고 누른 클릭이 방금 열린
	 *  메뉴를 도로 닫았다. 누르면 오히려 고정되고, 다시 누를 때 닫힌다. */
	it("hover로 연 메뉴는 클릭해도 닫히지 않고, 한 번 더 눌러야 닫힌다", () => {
		vi.useFakeTimers();
		try {
			render(
				<DesktopAddMenuButton
					desktop={DESKTOP}
					onAddAgent={vi.fn()}
					onAddTerminal={vi.fn()}
				/>,
			);
			const trigger = screen.getByLabelText("desktop 1에 추가");
			fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
			act(() => {
				vi.advanceTimersByTime(HOVER_MENU_OPEN_DELAY_MS);
			});
			expect(screen.getByRole("menuitem", { name: "터미널 열기" })).toBeTruthy();

			fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
			act(() => {
				vi.advanceTimersByTime(HOVER_MENU_CLOSE_DELAY_MS);
			});
			expect(screen.getByRole("menuitem", { name: "터미널 열기" })).toBeTruthy();

			// 눌러서 고정된 메뉴는 포인터가 떠나도 남는다 — 클릭한 메뉴의 상식.
			fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
			act(() => {
				vi.advanceTimersByTime(HOVER_MENU_CLOSE_DELAY_MS);
			});
			expect(screen.getByRole("menuitem", { name: "터미널 열기" })).toBeTruthy();

			// 두 번째 누름은 평범한 토글이다.
			fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
			expect(screen.queryByRole("menuitem")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	/** 가리키기만 해도 열린다 — 메뉴를 여는 클릭이 같은 동작에 한 단계를 더
	 *  얹고 있었다(사용자 요청 2026-08-31). */
	it("hover만으로 열리고, 지연 전에 벗어나면 열리지 않는다", () => {
		vi.useFakeTimers();
		try {
			render(
				<DesktopAddMenuButton
					desktop={DESKTOP}
					onAddAgent={vi.fn()}
					onAddTerminal={vi.fn()}
				/>,
			);
			const trigger = screen.getByRole("button", {
				name: "desktop 1에 추가",
			});

			// 스쳐 지나간 포인터는 메뉴를 띄우지 않는다.
			fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
			fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
			act(() => {
				vi.advanceTimersByTime(HOVER_MENU_OPEN_DELAY_MS);
			});
			expect(screen.queryByRole("menuitem")).toBeNull();

			fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
			act(() => {
				vi.advanceTimersByTime(HOVER_MENU_OPEN_DELAY_MS);
			});
			expect(
				screen.getByRole("menuitem", { name: "터미널 열기" }),
			).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});
});
