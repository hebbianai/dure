// @vitest-environment jsdom
// 시안 2538:69919 — 아이콘만 있던 24px 버튼이 "폴더에서 보기" 레이블 버튼이 되고,
// 행 사이는 hairline 하나로만 나뉜다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const revealItemInDir = vi.fn(async (_path: string) => {});
const appHomeInfo = vi.fn();

vi.mock("@tauri-apps/plugin-opener", () => ({
	revealItemInDir: (path: string) => revealItemInDir(path),
}));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	appHomeInfo: () => appHomeInfo(),
}));

import { StoragePage } from "@/components/settings/StoragePage";

const INFO = {
	appRoot: "/Users/seung/.dure",
	appRootSource: "renamed" as const,
	appDataDir: "/Users/seung/Library/Application Support/io.hebbian.ade",
	cliInstallRoot: "/Users/seung/.local/share/hebbian-ide-cli",
	discoveryRoot: "/Users/seung/Library/Application Support/hebbian/hmux-hosts",
};

afterEach(() => {
	cleanup();
	revealItemInDir.mockClear();
	appHomeInfo.mockReset();
});

describe("StoragePage", () => {
	it("경로마다 레이블 있는 '폴더에서 보기' 버튼을 준다", async () => {
		appHomeInfo.mockResolvedValue(INFO);
		render(<StoragePage />);
		await waitFor(() =>
			expect(screen.getAllByRole("button", { name: "폴더에서 보기" })).toHaveLength(4),
		);
	});

	it("버튼을 누르면 그 행의 경로를 연다", async () => {
		appHomeInfo.mockResolvedValue(INFO);
		render(<StoragePage />);
		const buttons = await screen.findAllByRole("button", { name: "폴더에서 보기" });
		fireEvent.click(buttons[0]);
		expect(revealItemInDir).toHaveBeenCalledWith("/Users/seung/.dure");
	});

	it("경로가 없는 항목은 행 자체를 그리지 않는다", async () => {
		appHomeInfo.mockResolvedValue({ ...INFO, appDataDir: null, discoveryRoot: null });
		render(<StoragePage />);
		await waitFor(() =>
			expect(screen.getAllByRole("button", { name: "폴더에서 보기" })).toHaveLength(2),
		);
		expect(screen.queryByText("앱 상태")).toBeNull();
	});

	// 경로는 읽고 복사하는 값이라 전역 user-select:none의 탈출구가 필요하다.
	it("경로 문단은 selectable로 남는다", async () => {
		appHomeInfo.mockResolvedValue(INFO);
		const { container } = render(<StoragePage />);
		await waitFor(() => expect(screen.getByText("/Users/seung/.dure")).toBeTruthy());
		expect(container.querySelectorAll("[data-selectable]").length).toBe(4);
	});
});
