import { describe, expect, it } from "vitest";
import { DEFAULT_SPACES_VIEW_OPTIONS } from "@/lib/spaces/spacesViewOptions";
import {
	type ThemeDefinition,
	ThemeIdCollisionError,
} from "@/lib/theme/themeDefinition";
import { createAppPrefsStoreSlice } from "./appPrefsStoreSlice";

/** Minimal host harness — applies updater patches the way zustand's set does
 *  and counts identity-return no-ops. */
function harness() {
	const slice = createAppPrefsStoreSlice((updater) => {
		const next = updater(host.state);
		if (next === host.state) {
			host.noops += 1;
			return;
		}
		host.state = { ...host.state, ...next };
	});
	const host = { noops: 0, state: slice };
	return host;
}

const theme = (id: string): ThemeDefinition =>
	({ id, name: id, appearance: "dark" }) as ThemeDefinition;

describe("appPrefsStoreSlice", () => {
	it("터미널 글꼴 크기는 0.5 단위로 반올림되고 8~30으로 제한된다", () => {
		const host = harness();
		host.state.setTerminalFontSize(13.3);
		expect(host.state.terminalFontSize).toBe(13.5);
		host.state.setTerminalFontSize(999);
		expect(host.state.terminalFontSize).toBe(30);
		host.state.setTerminalFontSize((cur) => cur - 100);
		expect(host.state.terminalFontSize).toBe(8);
	});

	it("bumpStats는 부분 갱신을 누적하고 없는 항목은 그대로 둔다", () => {
		const host = harness();
		host.state.bumpStats({ agentsStarted: 1 });
		host.state.bumpStats({ agentsStarted: 1, activeMs: 500 });
		expect(host.state.stats.agentsStarted).toBe(2);
		expect(host.state.stats.activeMs).toBe(500);
		expect(host.state.stats.prsCreated).toBe(0);
	});

	it("resetShortcutOverride는 지울 것이 없으면 빈 패치를 내고, 있으면 그 항목만 거둔다", () => {
		const host = harness();
		const before = host.state.shortcutOverrides;
		host.state.resetShortcutOverride("ghost");
		expect(host.state.shortcutOverrides).toEqual(before);
		host.state.setShortcutOverride("cmd.save", null);
		expect("cmd.save" in host.state.shortcutOverrides).toBe(true);
		host.state.resetShortcutOverride("cmd.save");
		expect("cmd.save" in host.state.shortcutOverrides).toBe(false);
	});

	it("addCustomTheme는 id 충돌이면 던지고 목록을 바꾸지 않는다", () => {
		const host = harness();
		host.state.addCustomTheme(theme("my-theme"));
		expect(host.state.customThemes.map((t) => t.id)).toEqual(["my-theme"]);
		expect(() => host.state.addCustomTheme(theme("my-theme"))).toThrow(
			ThemeIdCollisionError,
		);
		expect(host.state.customThemes).toHaveLength(1);
	});

	it("removeCustomTheme는 그 테마를 선택한 themeScheme 슬롯도 함께 비운다", () => {
		const host = harness();
		host.state.addCustomTheme(theme("my-theme"));
		host.state.setUiPrefs({ themeScheme: { dark: "my-theme" } });
		host.state.removeCustomTheme("my-theme");
		expect(host.state.customThemes).toEqual([]);
		expect(host.state.uiPrefs.themeScheme?.dark).toBeUndefined();
	});

	it("normalizes Spaces view options without replacing them on unrelated updates", () => {
		const host = harness();
		const before = host.state.uiPrefs.spacesViewOptions;
		host.state.setUiPrefs({ theme: "light" });
		expect(host.state.uiPrefs.spacesViewOptions).toBe(before);

		host.state.setUiPrefs({
			spacesViewOptions: { groupBy: "machine" } as never,
		});
		expect(host.state.uiPrefs.spacesViewOptions).toEqual(
			DEFAULT_SPACES_VIEW_OPTIONS,
		);

		host.state.setUiPrefs({
			spacesViewOptions: {
				...DEFAULT_SPACES_VIEW_OPTIONS,
				groupBy: "status",
				orderBy: "updated",
			},
		});
		expect(host.state.uiPrefs.spacesViewOptions).toEqual({
			...DEFAULT_SPACES_VIEW_OPTIONS,
			groupBy: "status",
			orderBy: "updated",
		});

		host.state.setUiPrefs({
			spacesViewOptions: {
				...host.state.uiPrefs.spacesViewOptions,
				groupBy: "environment",
			},
		});
		expect(host.state.uiPrefs.spacesViewOptions.groupBy).toBe("environment");
	});

	it("normalizes Sessions view options without replacing them on unrelated updates", () => {
		const host = harness();
		const before = host.state.uiPrefs.sessionsViewOptions;
		host.state.setUiPrefs({ theme: "light" });
		expect(host.state.uiPrefs.sessionsViewOptions).toBe(before);

		host.state.setUiPrefs({
			sessionsViewOptions: {
				groupBy: "machine",
				orderBy: "oldest",
				paneFilter: "open_only",
			} as never,
		});
		expect(host.state.uiPrefs.sessionsViewOptions).toEqual({
			groupBy: "repository",
			orderBy: "oldest",
			paneFilter: "open_only",
		});
	});
});
