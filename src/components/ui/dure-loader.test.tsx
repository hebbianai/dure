// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { DureLoader } from "./dure-loader";

describe("DureLoader", () => {
	afterEach(cleanup);

	it("announces progress through the shared loading label", () => {
		render(<DureLoader />);
		const loader = screen.getByRole("status", { name: t("common.loading") });
		expect(loader).toBeTruthy();
	});

	it("takes the caller's progress label", () => {
		render(<DureLoader size={16} label="Attaching" className="ml-2" />);
		const loader = screen.getByRole("status", { name: "Attaching" });
		expect(loader).toBeTruthy();
	});

	it("hides itself from assistive tech when the surroundings already speak", () => {
		const { container } = render(<DureLoader decorative />);
		const loader = container.querySelector(".dure-loader") as HTMLElement;
		expect(loader.getAttribute("aria-hidden")).toBe("true");
		expect(loader.hasAttribute("role")).toBe(false);
		expect(loader.hasAttribute("aria-label")).toBe(false);
	});
});
