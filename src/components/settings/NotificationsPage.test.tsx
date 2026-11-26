// @vitest-environment jsdom
// 시안 2524:70567 — 720px 카드가 사라지고 스위치 행이 hairline으로만 나뉜다.
// 행 전체가 label이라 설명 문장을 눌러도 토글된다(시안이 행을 통째로 버튼으로
// 그린 의도). 스위치를 버튼 안에 넣으면 중첩 인터랙티브가 되므로 label로 감쌌다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/ipc/notifications", () => ({
	notificationStatus: vi.fn(async () => ({
		authorization: "authorized",
		sender: "dure-app",
		presentation: "temporary",
	})),
	notificationRequestAuthorization: vi.fn(),
	notificationOpenSettings: vi.fn(async () => undefined),
	notificationBackendFailure: (error: unknown) => ({
		authorization: "unknown",
		sender: "unknown",
		detail: String(error),
	}),
}));
vi.mock("@/lib/settings/notify", () => ({ systemNotify: vi.fn() }));
const platform = vi.hoisted(() => ({ current: "macos" as "macos" | "windows" }));
vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
	isMacPlatform: () => platform.current === "macos",
	detectDesktopPlatform: () => platform.current,
}));

import { NotificationsPage } from "@/components/settings/NotificationsPage";
import { notificationOpenSettings } from "@/lib/ipc/notifications";
import { DEFAULT_NOTIFY_PREFS, useStore } from "@/store";

afterEach(() => {
	cleanup();
	platform.current = "macos";
	useStore.setState({ notifyPrefs: { ...DEFAULT_NOTIFY_PREFS } });
});

describe("NotificationsPage", () => {
	it("설명 문장을 눌러도 그 줄의 스위치가 토글된다", () => {
		useStore.setState({ notifyPrefs: { ...DEFAULT_NOTIFY_PREFS, enabled: true } });
		render(<NotificationsPage />);
		fireEvent.click(screen.getByText("백그라운드 이벤트에 대한 기본 시스템 알림입니다."));
		expect(useStore.getState().notifyPrefs.enabled).toBe(false);
	});

	// 시안에 없는 두 줄이지만 agentAttentionNotifier가 실제로 읽는 게이트라,
	// 스위치를 지우면 알림은 계속 오는데 끄는 길이 사라진다.
	it("시안에 없는 승인 필요·세션 종료 스위치를 계속 제공한다", () => {
		render(<NotificationsPage />);
		expect(screen.getByText("승인 필요")).toBeTruthy();
		expect(screen.getByText("Agent 세션 종료")).toBeTruthy();
	});

	it("Dock 배지 스위치가 알림 스위치와 따로 배지 설정을 바꾼다", () => {
		render(<NotificationsPage />);
		fireEvent.click(screen.getByText("Dock 배지"));
		expect(useStore.getState().notifyPrefs).toMatchObject({
			appIconBadge: false,
			enabled: true,
		});
	});

	it("Dock이 없는 플랫폼에서는 Dock 배지 스위치를 보여 주지 않는다", () => {
		platform.current = "windows";
		render(<NotificationsPage />);
		expect(screen.queryByText("Dock 배지")).toBeNull();
	});

	it("turns messages from agents (dure notify) off and on", () => {
		render(<NotificationsPage />);
		expect(useStore.getState().notifyPrefs.agentMessage).toBe(true);
		fireEvent.click(screen.getByText("에이전트가 보낸 메시지"));
		expect(useStore.getState().notifyPrefs.agentMessage).toBe(false);
		fireEvent.click(screen.getByText("에이전트가 보낸 메시지"));
		expect(useStore.getState().notifyPrefs.agentMessage).toBe(true);
	});

	it("페이지를 감싸던 720px 카드를 더 이상 그리지 않는다", () => {
		const { container } = render(<NotificationsPage />);
		expect(container.querySelector(".max-w-\\[720px\\]")).toBeNull();
	});

	it("임시 macOS 알림이면 지속적으로 표시하는 정확한 설정 경로를 안내한다", async () => {
		render(<NotificationsPage />);

		expect(
			await screen.findByText(
				"알림이 화면에 계속 남도록 macOS에서 알림 스타일을 ‘지속적’으로 설정하세요.",
			),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: "지속적 알림 설정 열기" }),
		);
		expect(notificationOpenSettings).toHaveBeenCalledOnce();
	});
});
