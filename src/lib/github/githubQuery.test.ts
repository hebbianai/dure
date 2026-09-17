import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n";
import { githubQueryFailureMessage } from "./githubQuery";

afterEach(() => setLang("ko"));

describe("GitHub read failure messages", () => {
	it("uses localized explanations for classified failures and preserves command details", () => {
		setLang("en");
		const english = githubQueryFailureMessage({
			kind: "timed-out",
			detail: "",
		});
		setLang("ko");
		expect(
			githubQueryFailureMessage({ kind: "timed-out", detail: "" }),
		).not.toBe(english);
		expect(
			githubQueryFailureMessage({
				kind: "command-failed",
				detail: "Forbidden",
			}),
		).toBe("Forbidden");
		expect(
			githubQueryFailureMessage({ kind: "command-failed", detail: "" }),
		).not.toBe("");
	});
});
