// @vitest-environment jsdom
// 시안 2525:72518 — 720px 카드와 목록을 담던 sunken 카드를 걷어내고, 행 사이
// 구분선 없이 24px 간격만으로 나눈다. 상자로 남는 건 안내 배너 하나뿐이다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const macosPermissions = vi.fn();
const openPrivacyPane = vi.fn(async (_pane: string) => {});
const requestPrivacyPrompt = vi.fn(async (_kind: string) => {});

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	macosPermissions: () => macosPermissions(),
	openPrivacyPane: (pane: string) => openPrivacyPane(pane),
	requestPrivacyPrompt: (kind: string) => requestPrivacyPrompt(kind),
}));

import { MacosPermsPage } from "@/components/settings/MacosPermsPage";

const PERMS = {
	microphone: false,
	camera: null,
	screen_recording: true,
	accessibility: true,
	full_disk: true,
	bluetooth: true,
};

afterEach(() => {
	cleanup();
	macosPermissions.mockReset();
	openPrivacyPane.mockClear();
	requestPrivacyPrompt.mockClear();
});

describe("MacosPermsPage", () => {
	it("권한 아홉 줄을 모두 그린다", async () => {
		macosPermissions.mockResolvedValue(PERMS);
		render(<MacosPermsPage />);
		await waitFor(() => expect(screen.getByText("마이크")).toBeTruthy());
		for (const label of [
			"마이크",
			"카메라",
			"화면 녹화",
			"접근성",
			"전체 디스크 액세스",
			"자동화",
			"로컬 네트워크",
			"USB 장치",
			"블루투스",
		]) {
			expect(screen.getByText(label)).toBeTruthy();
		}
	});

	// 시안은 행마다 버튼 하나만 그렸지만, 프롬프트가 이미 거부된 뒤에는 아무 일도
	// 일어나지 않아 "설정 열기"가 유일한 탈출구가 된다.
	it("자동화·로컬 네트워크는 권한 요청과 설정 열기를 함께 준다", async () => {
		macosPermissions.mockResolvedValue(PERMS);
		render(<MacosPermsPage />);
		await waitFor(() => expect(screen.getByText("자동화")).toBeTruthy());
		expect(screen.getAllByRole("button", { name: /권한 요청/ })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: /설정 열기/ })).toHaveLength(9);
	});

	it("프로브가 실패해도 목록은 그대로 그린다", async () => {
		macosPermissions.mockRejectedValue(new Error("no ipc"));
		render(<MacosPermsPage />);
		await waitFor(() => expect(screen.getByText("마이크")).toBeTruthy());
		// 상태를 모르면 전부 "수동 확인"으로 떨어진다.
		expect(screen.getAllByText("수동 확인").length).toBe(9);
	});

	it("새로고침을 누르면 권한을 다시 조회한다", async () => {
		macosPermissions.mockResolvedValue(PERMS);
		render(<MacosPermsPage />);
		await waitFor(() => expect(macosPermissions).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByRole("button", { name: /새로고침/ }));
		await waitFor(() => expect(macosPermissions).toHaveBeenCalledTimes(2));
	});
});
