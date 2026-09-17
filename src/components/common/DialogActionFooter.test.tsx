// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DialogActionFooter } from "@/components/common/DialogActionFooter";

afterEach(cleanup);

describe("DialogActionFooter", () => {
	it("renders cancel + confirm and wires both callbacks", () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		render(
			<DialogActionFooter
				onCancel={onCancel}
				confirmLabel="실행"
				onConfirm={onConfirm}
			/>,
		);

		const cancel = screen.getByRole("button", { name: "취소" });
		fireEvent.click(cancel);
		expect(onCancel).toHaveBeenCalledOnce();

		const confirmButton = screen.getByRole("button", { name: "실행" });
		fireEvent.click(confirmButton);
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("disables both buttons, shows the spinner, and swaps to busyLabel while busy", () => {
		render(
			<DialogActionFooter
				cancelLabel="취소"
				onCancel={vi.fn()}
				confirmLabel="저장"
				busyLabel="저장 중…"
				busy
				onConfirm={vi.fn()}
			/>,
		);

		const cancel = screen.getByRole("button", { name: "취소" });
		expect(cancel.hasAttribute("disabled")).toBe(true);
		expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
		const confirmButton = screen.getByRole("button", { name: "저장 중…" });
		expect(confirmButton.hasAttribute("disabled")).toBe(true);
		expect(confirmButton.querySelector(".dure-loader")).toBeTruthy();
	});

	it("keeps confirmLabel while busy when no busyLabel is given", () => {
		render(
			<DialogActionFooter
				onCancel={vi.fn()}
				confirmLabel="정리"
				busy
				onConfirm={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "정리" })).toBeTruthy();
	});

	it("disables only confirm while cancel remains available", () => {
		const onCancel = vi.fn();
		render(
			<DialogActionFooter
				onCancel={onCancel}
				confirmLabel="제거"
				variant="destructive"
				disabled
				onConfirm={vi.fn()}
			/>,
		);

		const confirmButton = screen.getByRole("button", { name: "제거" });
		expect(confirmButton.hasAttribute("disabled")).toBe(true);
		const cancel = screen.getByRole("button", { name: "취소" });
		expect(cancel.hasAttribute("disabled")).toBe(false);
		fireEvent.click(cancel);
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("renders a caller-supplied spinner override while busy", () => {
		render(
			<DialogActionFooter
				onCancel={vi.fn()}
				confirmLabel="다시 시작"
				busy
				icon={<span data-testid="custom-spinner" />}
				onConfirm={vi.fn()}
			/>,
		);
		expect(screen.getByTestId("custom-spinner")).toBeTruthy();
		const confirmButton = screen.getByRole("button", { name: "다시 시작" });
		expect(confirmButton.querySelector(".dure-loader")).toBeNull();
	});
});
