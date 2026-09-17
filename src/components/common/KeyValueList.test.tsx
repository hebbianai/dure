// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KeyValueList, KeyValueRow } from "@/components/common/KeyValueList";

afterEach(cleanup);

describe("KeyValueList", () => {
	it("renders a semantic dl with dt/dd rows", () => {
		const { container } = render(
			<KeyValueList>
				<KeyValueRow label="주소">10.0.0.2:443</KeyValueRow>
				<KeyValueRow label="상태">정상</KeyValueRow>
			</KeyValueList>,
		);
		const list = container.querySelector("dl");
		expect(list).not.toBeNull();
		const terms = container.querySelectorAll("dl dt");
		const values = container.querySelectorAll("dl dd");
		expect(terms.length).toBe(2);
		expect(values.length).toBe(2);
		expect(terms[0]?.textContent).toBe("주소");
		expect(values[0]?.textContent).toBe("10.0.0.2:443");
	});

	it("publishes labelWidth as the shared label-column variable", () => {
		const { container } = render(
			<KeyValueList labelWidth="5rem" className="rounded-lg">
				<KeyValueRow label="지문">ab:cd</KeyValueRow>
			</KeyValueList>,
		);
		const list = container.querySelector("dl") as HTMLElement;
		expect(list.style.getPropertyValue("--kv-label-width")).toBe("5rem");
		expect(list.className).toContain("divide-y");
		expect(list.className).toContain("rounded-lg");
		const row = list.firstElementChild as HTMLElement;
		expect(row.className).toContain(
			"grid-cols-[var(--kv-label-width)_minmax(0,1fr)]",
		);
	});

	it("switches the value voice with mono and marks selectable values", () => {
		const { container } = render(
			<KeyValueList>
				<KeyValueRow label="세션 ID" mono selectable>
					sess_0192
				</KeyValueRow>
				<KeyValueRow label="종류">터미널</KeyValueRow>
			</KeyValueList>,
		);
		const values = container.querySelectorAll("dd");
		expect(values[0]?.className).toContain("font-mono");
		expect(values[0]?.className).toContain("text-[11px]");
		expect(values[0]?.hasAttribute("data-selectable")).toBe(true);
		expect(values[1]?.className).not.toContain("font-mono");
		expect(values[1]?.hasAttribute("data-selectable")).toBe(false);
	});
});
