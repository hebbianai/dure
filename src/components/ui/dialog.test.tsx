// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { focusByKeyboard } from "@/test/keyboardFocus";

describe("DialogContent close button", () => {
	afterEach(cleanup);

	it("is named for assistive tech but shows no hint — the glyph says it", () => {
		render(
			<Dialog open>
				<DialogContent aria-describedby={undefined}>
					<DialogTitle>Connections</DialogTitle>
				</DialogContent>
			</Dialog>,
		);
		const close = screen.getByRole("button", { name: t("common.close") });

		focusByKeyboard(close);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});
});
