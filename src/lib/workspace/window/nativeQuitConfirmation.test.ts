import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureLangLoaded, setLang } from "@/lib/i18n";
import canonicalCopy from "../../../../src-tauri/src/quit_confirmation.en.json";
import { syncNativeQuitConfirmationCopy } from "./nativeQuitConfirmation";

const native = vi.hoisted(() => ({
	invoke: vi.fn(),
	isTauri: vi.fn(),
	isMac: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: native.invoke,
	isTauri: native.isTauri,
}));
vi.mock("@/lib/workspace/desktop/desktopPlatform", () => ({
	isMacPlatform: native.isMac,
}));

afterEach(() => {
	setLang("en");
	vi.resetAllMocks();
});

describe("native quit confirmation translations", () => {
	it("does not call a native command in a browser or on other platforms", async () => {
		native.isTauri.mockReturnValue(false);
		native.isMac.mockReturnValue(true);
		await syncNativeQuitConfirmationCopy();
		native.isTauri.mockReturnValue(true);
		native.isMac.mockReturnValue(false);
		await syncNativeQuitConfirmationCopy();
		expect(native.invoke).not.toHaveBeenCalled();
	});

	it("uses the same canonical default as native startup, then follows language changes", async () => {
		native.isTauri.mockReturnValue(true);
		native.isMac.mockReturnValue(true);
		setLang("en");
		await syncNativeQuitConfirmationCopy();
		expect(native.invoke).toHaveBeenLastCalledWith(
			"set_app_quit_confirmation_copy",
			{ copy: canonicalCopy },
		);

		for (const lang of ["ko", "es", "fr", "pt", "ja", "zh"] as const) {
			await ensureLangLoaded(lang);
			setLang(lang);
			await syncNativeQuitConfirmationCopy();
			const copy = native.invoke.mock.lastCall?.[1].copy;
			expect(Object.keys(copy)).toEqual(Object.keys(canonicalCopy));
			for (const [key, value] of Object.entries(copy)) {
				expect(value).not.toBe(key);
				expect(value).not.toBe(
					canonicalCopy[key as keyof typeof canonicalCopy],
				);
			}
		}
	});
});
