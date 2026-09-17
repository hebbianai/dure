// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Kbd } from "./kbd";

const kbdOf = (container: HTMLElement) =>
	container.querySelector("kbd") as HTMLElement;

describe("Kbd", () => {
	afterEach(cleanup);

	it("기본 md는 ShortcutsPage 키캡 클래스를 바이트 그대로 그린다", () => {
		const { container } = render(<Kbd>⌘</Kbd>);
		const kbd = kbdOf(container);

		expect(kbd.className).toBe(
			"flex h-6 min-w-6 items-center justify-center rounded-md border border-input bg-glass-chrome px-1.5 font-mono text-[11px] text-foreground",
		);
		expect(kbd.textContent).toBe("⌘");
	});

	it("sm은 NativeSearchDialog 단축키 힌트 클래스를 바이트 그대로 그린다", () => {
		const { container } = render(<Kbd size="sm">⌘P</Kbd>);
		const kbd = kbdOf(container);

		expect(kbd.className).toBe(
			"rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground",
		);
		expect(kbd.textContent).toBe("⌘P");
	});

	it("호출부 className이 같은 그룹의 기본 클래스를 대체한다", () => {
		const { container } = render(<Kbd className="min-w-8">K</Kbd>);
		const classes = kbdOf(container).className.split(/\s+/);

		expect(classes).toContain("min-w-8");
		expect(classes).not.toContain("min-w-6");
	});
});
