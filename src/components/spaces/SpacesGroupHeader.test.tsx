// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpacesGroupHeader } from "@/components/spaces/SpacesGroupHeader";
import { t } from "@/lib/i18n";

afterEach(() => {
	cleanup();
});

function header(attentionCount?: number, programStatusCount?: number) {
	return (
		<SpacesGroupHeader
			desktop={{ id: "desktop-1", name: "Main" }}
			isDropTarget={false}
			canClose
			onActivate={vi.fn()}
			onAddAgent={vi.fn()}
			onAddTerminal={vi.fn()}
			attentionCount={attentionCount}
			programStatusCount={programStatusCount}
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

	it("keeps a terminal program's own waiting count apart from Host attention", () => {
		render(header(2, 1));
		expect(screen.getByLabelText("주의 필요 2개").textContent).toContain("2");
		expect(
			screen.getByLabelText(t("spaces.group.programStatusCount", { n: 1 }))
				.textContent,
		).toContain("1");
	});

	it("speaks for a waiting program even when Host attention has nothing to say", () => {
		render(header(0, 3));
		expect(screen.queryByLabelText(/주의 필요/)).toBeNull();
		expect(
			screen.getByLabelText(t("spaces.group.programStatusCount", { n: 3 })),
		).toBeTruthy();
	});

	it("draws no program count when nothing reports waiting", () => {
		render(header(0, 0));
		expect(
			screen.queryByLabelText(t("spaces.group.programStatusCount", { n: 0 })),
		).toBeNull();
	});
});
