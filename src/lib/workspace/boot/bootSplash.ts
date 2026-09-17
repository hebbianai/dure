/**
 * The boot splash: the logo dot field over the window from the first moment
 * the document exists until the workspace has painted.
 *
 * This runs from index.html ahead of the app bundle, because the wait it
 * covers *is* the app bundle — a cold start spends most of its blank time
 * before React has anything to mount. So there is no React here, no store, no
 * stylesheet: the layer is built with inline styles, the theme is read from the
 * persisted store JSON with the same rule the app applies later, and the ink
 * is `var(--foreground, CanvasText)` — the system text colour until index.css
 * arrives, the foreground token from then on.
 *
 * It sits BEHIND the app (z-index -1, before #root): whatever the shell has
 * painted covers it, so it is only ever seen where nothing exists yet, and it
 * shows faintly through the glass sidebar until it leaves. It only appears if
 * boot is actually slow (BOOT_SPLASH.showDelayMs), never blocks input, and
 * leaves on the workspace's own first paint, which Workspace.tsx announces
 * through WORKSPACE_PAINTED_EVENT (workspaceBootState). Under reduced motion
 * the field is drawn once, still, and the exit is a cut.
 */
import { DURABLE_APP_STORE_NAME } from "@/lib/persistence/durableAppStoreName";
import { resolveDarkAppearance } from "@/lib/theme/themeAppearance";
import { dureMarkSvgDataUrl } from "@/lib/ui/dureMark";
import {
	advancePulses,
	BOOT_SPLASH,
	type BootSplashPhase,
	bootSplashPhase,
	createDotFrame,
	DOT_FIELD,
	type DotPulse,
	dotFrame,
	type LogoDot,
	sampleDotField,
} from "@/lib/workspace/boot/logoDotField";
import { WORKSPACE_PAINTED_EVENT } from "@/lib/workspace/boot/workspaceBootState";

export const BOOT_SPLASH_ID = "dure-boot-splash";

export interface BootSplashOptions {
	readonly now?: () => number;
	readonly storage?: Pick<Storage, "getItem"> | null;
	readonly reducedMotion?: boolean;
	readonly systemDark?: boolean;
}

export interface BootSplashHandle {
	/** The workspace has painted; leave the way the phase policy says. */
	dismiss(): void;
	/** Tear everything down at once (tests, hot reload). */
	dispose(): void;
	phase(): BootSplashPhase;
}

/** The saved theme preference, read the way the store will read it. */
export function savedThemePreference(
	storage: Pick<Storage, "getItem"> | null,
): unknown {
	try {
		const raw = storage?.getItem(DURABLE_APP_STORE_NAME);
		if (!raw) return undefined;
		const value = JSON.parse(raw) as {
			state?: { uiPrefs?: { theme?: unknown } };
		};
		return value?.state?.uiPrefs?.theme;
	} catch {
		return undefined;
	}
}

const prefersReducedMotion = (win: Window) =>
	typeof win.matchMedia === "function" &&
	win.matchMedia("(prefers-reduced-motion: reduce)").matches;

const prefersDarkScheme = (win: Window) =>
	typeof win.matchMedia === "function" &&
	win.matchMedia("(prefers-color-scheme: dark)").matches;

export function installBootSplash(
	doc: Document,
	options: BootSplashOptions = {},
): BootSplashHandle {
	const win = doc.defaultView as Window;
	const now = options.now ?? (() => performance.now());
	const reducedMotion = options.reducedMotion ?? prefersReducedMotion(win);
	const storage =
		options.storage === undefined ? safeLocalStorage(win) : options.storage;

	// Appearance first, before any pixel: the same class useRootDarkClass will
	// set once the store hydrates, so the shell does not flash the other mode.
	const dark = resolveDarkAppearance(
		savedThemePreference(storage),
		options.systemDark ?? prefersDarkScheme(win),
	);
	doc.documentElement.classList.toggle("dark", dark);
	// CanvasText follows color-scheme; index.css owns it once loaded, so this
	// inline value is cleared when the splash leaves.
	doc.documentElement.style.colorScheme = dark ? "dark" : "light";

	const startedAt = now();
	let paintedAt: number | null = null;
	let layer: HTMLElement | null = null;
	let frame = 0;
	let showTimer: number | undefined;
	let fadeTimer: number | undefined;
	let disposed = false;
	let image: HTMLImageElement | null = null;

	const phase = () =>
		bootSplashPhase({
			startedAtMs: startedAt,
			paintedAtMs: paintedAt,
			nowMs: now(),
			reducedMotion,
		});

	const teardown = () => {
		if (disposed) return;
		disposed = true;
		win.clearTimeout(showTimer);
		win.clearTimeout(fadeTimer);
		win.cancelAnimationFrame(frame);
		if (image) image.onload = null;
		layer?.remove();
		layer = null;
		doc.documentElement.style.removeProperty("color-scheme");
		doc.removeEventListener(WORKSPACE_PAINTED_EVENT, onPainted);
	};

	const show = () => {
		if (disposed || layer || phase() !== "visible") return;
		layer = doc.createElement("div");
		layer.id = BOOT_SPLASH_ID;
		layer.setAttribute("aria-hidden", "true");
		layer.dataset.bootSplashPhase = "visible";
		// z-index -1 paints below every in-flow child of body, i.e. below #root:
		// pane cards are opaque and simply cover it; the glass shell tints it.
		layer.style.cssText =
			"position:fixed;inset:0;z-index:-1;display:flex;align-items:center;justify-content:center;" +
			"pointer-events:none;user-select:none;opacity:1;" +
			(reducedMotion
				? ""
				: `transition:opacity ${BOOT_SPLASH.fadeMs}ms ease-out;`);
		const canvas = doc.createElement("canvas");
		canvas.width = DOT_FIELD.size;
		canvas.height = DOT_FIELD.size;
		canvas.style.cssText =
			"width:clamp(180px,26vw,336px);height:auto;aspect-ratio:1/1;opacity:0.6;" +
			"color:var(--foreground, CanvasText);";
		layer.append(canvas);
		doc.body.prepend(layer);
		startField(canvas);
	};

	const startField = (canvas: HTMLCanvasElement) => {
		// Created through the document, not a global constructor, so the layer
		// keeps working against an injected document (tests) as well as the page.
		const img = doc.createElement("img");
		image = img;
		img.onload = () => {
			if (disposed) return;
			const size = DOT_FIELD.size;
			const offscreen = doc.createElement("canvas");
			offscreen.width = size;
			offscreen.height = size;
			const sampler = offscreen.getContext("2d");
			const context = canvas.getContext("2d");
			if (!sampler || !context) return;
			sampler.drawImage(img, 0, 0, size, size);
			const coverage = sampler.getImageData(0, 0, size, size).data;
			const dots: LogoDot[] = sampleDotField(
				(x, y) => coverage[((y | 0) * size + (x | 0)) * 4 + 3] / 255,
				size,
			);
			const pulses: DotPulse[] = [];
			const out = createDotFrame(dots.length);
			let ink = win.getComputedStyle(canvas).color;
			let ticks = 0;
			const paint = (t: number) => {
				context.clearRect(0, 0, size, size);
				context.fillStyle = ink;
				dotFrame(dots, pulses, t, out);
				for (let i = 0; i < dots.length; i += 1) {
					context.globalAlpha = out.alpha[i];
					context.beginPath();
					context.arc(dots[i].x, dots[i].y, out.radius[i], 0, Math.PI * 2);
					context.fill();
				}
				context.globalAlpha = 1;
			};
			if (reducedMotion) {
				paint(0);
				return;
			}
			let nextPulseAt = now() + 600;
			const tick = (t: number) => {
				if (disposed) return;
				if (!doc.hidden) {
					// index.css can land mid-splash; pick up the token when it does.
					if (ticks++ % 30 === 0) ink = win.getComputedStyle(canvas).color;
					nextPulseAt = advancePulses(pulses, dots, t, nextPulseAt, size);
					paint(t / 1000);
				}
				frame = win.requestAnimationFrame(tick);
			};
			frame = win.requestAnimationFrame(tick);
		};
		img.src = dureMarkSvgDataUrl(DOT_FIELD.size);
	};

	const dismiss = () => {
		if (disposed) return;
		if (paintedAt === null) paintedAt = now();
		win.clearTimeout(showTimer);
		const next = phase();
		if (next === "done" || !layer) {
			teardown();
			return;
		}
		layer.dataset.bootSplashPhase = "fading";
		layer.style.opacity = "0";
		fadeTimer = win.setTimeout(teardown, BOOT_SPLASH.fadeMs + 16);
	};

	function onPainted() {
		dismiss();
	}

	doc.addEventListener(WORKSPACE_PAINTED_EVENT, onPainted, { once: true });
	showTimer = win.setTimeout(show, BOOT_SPLASH.showDelayMs + 1);

	return { dismiss, dispose: teardown, phase };
}

function safeLocalStorage(win: Window): Storage | null {
	try {
		return win.localStorage;
	} catch {
		return null;
	}
}
