// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkSignalPill } from "@/components/common/WorkSignalPill";

afterEach(cleanup);

describe("WorkSignalPill", () => {
	it("keeps routine state quiet and intervention state distinct", () => {
		const { rerender } = render(<WorkSignalPill compact>Open</WorkSignalPill>);
		expect(screen.getByText("Open").parentElement?.className).toContain(
			"text-muted-foreground",
		);

		rerender(
			<WorkSignalPill compact tone="attention">
				Blocked
			</WorkSignalPill>,
		);
		expect(screen.getByText("Blocked").parentElement?.className).toContain(
			"text-status-warn",
		);
	});
});
