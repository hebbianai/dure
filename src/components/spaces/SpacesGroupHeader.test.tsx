// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpacesGroupHeader } from "@/components/spaces/SpacesGroupHeader";

afterEach(() => {
	cleanup();
});

function header(attentionCount?: number) {
	return (
		<SpacesGroupHeader
			desktop={{ id: "desktop-1", name: "Main" }}
			isDropTarget={false}
			canClose
			onActivate={vi.fn()}
			onAddAgent={vi.fn()}
			onAddTerminal={vi.fn()}
			attentionCount={attentionCount}
		/>
	);
}

describe("SpacesGroupHeader attention rollup", () => {
	it("counts sessions that need a human next to the desktop name", () => {
		render(header(3));
		const rollup = screen.getByLabelText("주의 필요 3개");
		expect(rollup.textContent).toContain("3");
	});

	it("stays silent when nothing needs attention — SOUL의 침묵 예산", () => {
		render(header(0));
		expect(screen.queryByLabelText(/주의 필요/)).toBeNull();
	});
});
