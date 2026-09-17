// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LocationSection } from "@/components/agents/addAgent/LocationSection";
import { t } from "@/lib/i18n";

it("opens the folder browser from an empty location control", () => {
	const onBrowse = vi.fn();
	render(
		<LocationSection
			projects={[]}
			selected={null}
			recents={[]}
			onSelect={vi.fn()}
			onBrowse={onBrowse}
		/>,
	);

	fireEvent.click(
		screen.getByRole("button", { name: t("common.location") }),
	);

	expect(onBrowse).toHaveBeenCalledOnce();
});
