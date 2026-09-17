// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BOOT_SPLASH_ID,
	type BootSplashHandle,
	installBootSplash,
	savedThemePreference,
} from "@/lib/workspace/boot/bootSplash";
import { BOOT_SPLASH } from "@/lib/workspace/boot/logoDotField";
import { WORKSPACE_PAINTED_EVENT } from "@/lib/workspace/boot/workspaceBootState";

let handle: BootSplashHandle | null = null;
let clock = 0;
const now = () => clock;
const tick = (ms: number) => {
	clock += ms;
	vi.advanceTimersByTime(ms);
};
const layer = () => document.getElementById(BOOT_SPLASH_ID);
const painted = () =>
	document.dispatchEvent(new Event(WORKSPACE_PAINTED_EVENT));
const memoryStorage = (theme?: string) => ({
	getItem: () =>
		theme === undefined
			? null
			: JSON.stringify({ state: { uiPrefs: { theme } }, version: 8 }),
});

beforeEach(() => {
	vi.useFakeTimers();
	clock = 1000;
	document.documentElement.className = "";
	document.documentElement.style.removeProperty("color-scheme");
});

afterEach(() => {
	handle?.dispose();
	handle = null;
	vi.useRealTimers();
});

describe("installBootSplash", () => {
	it("shows nothing while boot is quick, then the field once it is not", () => {
		handle = installBootSplash(document, {
			now,
			storage: null,
			reducedMotion: false,
		});
		expect(layer()).toBeNull();
		tick(BOOT_SPLASH.showDelayMs + 5);
		const el = layer();
		expect(el).not.toBeNull();
		expect(el?.getAttribute("aria-hidden")).toBe("true");
		expect(el?.style.pointerEvents).toBe("none");
		expect(el?.querySelector("canvas")).not.toBeNull();
		expect(handle.phase()).toBe("visible");
	});

	it("stays behind the app: below #root in paint order, never over a pane", () => {
		const root = document.createElement("div");
		root.id = "root";
		document.body.append(root);
		try {
			handle = installBootSplash(document, {
				now,
				storage: null,
				reducedMotion: false,
			});
			tick(BOOT_SPLASH.showDelayMs + 5);
			const el = layer();
			expect(el?.style.zIndex).toBe("-1");
			expect(el?.style.position).toBe("fixed");
			// Prepended, so it also precedes #root in tree order.
			expect(document.body.firstElementChild).toBe(el);
		} finally {
			root.remove();
		}
	});

	it("never appears when the workspace paints inside the delay", () => {
		handle = installBootSplash(document, {
			now,
			storage: null,
			reducedMotion: false,
		});
		tick(40);
		painted();
		tick(BOOT_SPLASH.showDelayMs + BOOT_SPLASH.fadeMs + 50);
		expect(layer()).toBeNull();
		expect(handle.phase()).toBe("done");
	});

	it("fades on the workspace's first paint, then removes itself", () => {
		handle = installBootSplash(document, {
			now,
			storage: null,
			reducedMotion: false,
		});
		tick(BOOT_SPLASH.showDelayMs + 300);
		painted();
		expect(layer()?.dataset.bootSplashPhase).toBe("fading");
		expect(layer()?.style.opacity).toBe("0");
		tick(BOOT_SPLASH.fadeMs + 20);
		expect(layer()).toBeNull();
	});

	it("cuts instead of fading under reduced motion", () => {
		handle = installBootSplash(document, {
			now,
			storage: null,
			reducedMotion: true,
		});
		tick(BOOT_SPLASH.showDelayMs + 300);
		expect(layer()).not.toBeNull();
		painted();
		expect(layer()).toBeNull();
	});

	it("applies the saved appearance before anything else renders", () => {
		handle = installBootSplash(document, {
			now,
			storage: memoryStorage("light"),
			reducedMotion: true,
			systemDark: true,
		});
		expect(document.documentElement.classList.contains("dark")).toBe(false);
		expect(document.documentElement.style.colorScheme).toBe("light");
		handle.dispose();

		handle = installBootSplash(document, {
			now,
			storage: memoryStorage("system"),
			reducedMotion: true,
			systemDark: true,
		});
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		handle.dispose();

		// Nothing saved yet: the app default is dark.
		handle = installBootSplash(document, {
			now,
			storage: null,
			reducedMotion: true,
			systemDark: false,
		});
		expect(document.documentElement.classList.contains("dark")).toBe(true);
	});

	it("hands color-scheme back to the stylesheet when it leaves", () => {
		handle = installBootSplash(document, {
			now,
			storage: null,
			reducedMotion: true,
		});
		expect(document.documentElement.style.colorScheme).toBe("dark");
		painted();
		expect(document.documentElement.style.colorScheme).toBe("");
	});

	it("reads the theme defensively from the persisted store shape", () => {
		expect(savedThemePreference(memoryStorage("light"))).toBe("light");
		expect(
			savedThemePreference({ getItem: () => "{not json" }),
		).toBeUndefined();
		expect(
			savedThemePreference({ getItem: () => JSON.stringify({ state: {} }) }),
		).toBeUndefined();
		expect(savedThemePreference(null)).toBeUndefined();
	});
});
