import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { readFile } from "@/lib/ipc/files";
import { qaLog } from "@/lib/qa/qaLog";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";
import type { Agent } from "@/types";

/** What work-detail-layout-home-setup.mjs wrote: the agents, the leads with
 * a few, five and many managed agents, one that manages nobody, and ended
 * agents whose provider keeps a short and a long last conversation. */
interface Fixture {
	agents: Agent[];
	leads: [few: string, five: string, many: string];
	solo: string;
	ended: [few: string, many: string];
}

/** What each ended agent's last conversation shows: the short one from its
 * first message to its last, the long one its last exchange, where a long
 * history opens (its older rows are not rendered until scrolled to). */
const ENDED_TEXT = {
	few: ["Rename the billing feature flags", "After 0.4 ships"],
	many: [
		"Write up what changed for the team.",
		"The note is in docs/testing.md",
	],
} as const;

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(
	message: string,
	ready: () => boolean,
	timeoutMs = 30_000,
) {
	const deadline = performance.now() + timeoutMs;
	while (!ready()) {
		check(performance.now() < deadline, message);
		await new Promise((done) => setTimeout(done, 50));
	}
}

/** Two frames, so a store change has painted before it is measured. */
const painted = () =>
	new Promise((done) =>
		requestAnimationFrame(() => requestAnimationFrame(done)),
	);

function column(key: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(
		`[data-work-column="${CSS.escape(key)}"]`,
	);
}

/** What one column shows, measured the way a person sees it, with whether
 * its conversation shows `expected` texts, the last in view. */
function columnFacts(key: string, expected: readonly string[] = []) {
	const root = column(key);
	check(root, `No Work column for ${key}`);
	const managed = root.querySelector<HTMLElement>('[data-slot="work-managed"]');
	const heading = Array.from(root.querySelectorAll("h3")).find(
		(element) => element.textContent === t("work.conversation.label"),
	);
	const conversation = root.querySelector<HTMLElement>(
		'[data-slot="work-conversation"]',
	);
	const details = managed?.querySelector("details");
	// The fold's body, then the scroller FoldLine caps its rows in.
	const scroller = details?.querySelector<HTMLElement>(":scope > div > div");
	const detail = root.querySelector<HTMLElement>(":scope > section");
	const rows = Array.from(
		managed?.querySelectorAll<HTMLElement>('[data-slot="agent-row"]') ?? [],
	);
	const activities = rows.map((row) => {
		const line = Array.from(row.querySelectorAll<HTMLElement>("span")).find(
			(span) =>
				span.textContent?.startsWith(t("agents.row.asked", { prompt: "" })),
		);
		const style = line ? getComputedStyle(line) : undefined;
		return line && style
			? {
					clamp: style.webkitLineClamp,
					height: line.getBoundingClientRect().height,
					lineHeight: Number.parseFloat(style.lineHeight),
				}
			: null;
	});
	const rect = (element: Element | null | undefined) => {
		if (!element) return null;
		const { top, bottom, height } = element.getBoundingClientRect();
		return { top, bottom, height };
	};
	/** Where the first thing a label paints starts: its dot (an empty
	 * element) or its words (text), whatever padding holds them. */
	const labelLeft = (element: Element | null | undefined) => {
		if (!element) return null;
		const walker = document.createTreeWalker(
			element,
			NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
		);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node instanceof Text && node.textContent?.trim()) {
				const range = document.createRange();
				range.selectNodeContents(node);
				return range.getBoundingClientRect().left;
			}
			if (node instanceof HTMLElement && node.childNodes.length === 0) {
				return node.getBoundingClientRect().left;
			}
		}
		return null;
	};
	const scrollerTop = scroller
		? scroller.getBoundingClientRect().top - scroller.scrollTop
		: 0;
	const card = root.querySelector("header");
	const visible = (text: string) => {
		const walker = document.createTreeWalker(
			conversation ?? root,
			NodeFilter.SHOW_TEXT,
		);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.textContent?.includes(text)) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			const { top, bottom } = range.getBoundingClientRect();
			const shown = conversation?.getBoundingClientRect();
			return Boolean(
				shown && top >= shown.top - 0.5 && bottom <= shown.bottom + 0.5,
			);
		}
		return false;
	};
	return {
		/** Whether the conversation reads its transcript, and whether it
		 * offers a composer or reports a failure. */
		transcript: {
			shows: expected.map(
				(text) => conversation?.textContent?.includes(text) ?? false,
			),
			lastVisible:
				expected.length > 0 && visible(expected[expected.length - 1]),
			composer: Boolean(conversation?.querySelector("textarea")),
			alert: Boolean(conversation?.querySelector('[role="alert"]')),
			none: Boolean(
				conversation?.textContent?.includes(t("work.conversation.none")),
			),
		},
		managed: managed
			? {
					open: details?.open ?? false,
					summary: details?.querySelector("summary")?.textContent ?? null,
					labelLeft: labelLeft(details?.querySelector("summary > span")),
					variants: rows.map((row) => row.dataset.variant),
					rowDotLeft:
						rows[0]?.firstElementChild?.getBoundingClientRect().left ?? null,
					activities,
					rect: rect(managed),
					scroller: scroller
						? {
								height: scroller.getBoundingClientRect().height,
								scrollHeight: scroller.scrollHeight,
								clientHeight: scroller.clientHeight,
							}
						: null,
					rowBottoms: Array.from(
						scroller?.firstElementChild?.children ?? [],
						(row) => row.getBoundingClientRect().bottom - scrollerTop,
					),
					borderTop: getComputedStyle(managed).borderTopWidth,
					borderColor: getComputedStyle(managed).borderTopColor,
				}
			: null,
		heading: heading
			? {
					rect: rect(heading),
					labelLeft: labelLeft(heading),
					borderTop: getComputedStyle(heading).borderTopWidth,
					borderColor: getComputedStyle(heading).borderTopColor,
				}
			: null,
		conversation: rect(conversation),
		detailHeight: detail?.getBoundingClientRect().height ?? null,
		cardSaysManaged: Boolean(
			card?.textContent?.includes(t("agents.row.manages", { n: "" }).trim()),
		),
	};
}

function facts(key: string, beside: string, expected?: readonly string[]) {
	return {
		dark: document.documentElement.classList.contains("dark"),
		viewport: { width: innerWidth, height: innerHeight },
		columns: Array.from(
			document.querySelectorAll<HTMLElement>("[data-work-column]"),
		).map((element) => element.dataset.workColumn),
		shown: columnFacts(key, expected),
		beside: key !== beside && column(beside) ? columnFacts(beside) : undefined,
		background: getComputedStyle(document.body).backgroundColor,
	};
}

/** A fresh home raises the first-run tooling notice over the window a
 * minute in; the probe closes it the way a person would, so it covers no
 * capture. */
function dismissNotices() {
	const close = JSON.stringify(t("common.close"));
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		`section > div > button[aria-label=${close}]`,
	)) {
		button.click();
	}
}

/** Each phase holds until the client has captured the window, closing a
 * notice that arrives while it waits. */
async function captured(home: string, phase: string) {
	const deadline = performance.now() + 180_000;
	for (;;) {
		dismissNotices();
		try {
			await readFile(`${home}/work-detail-captured-${phase}`);
			return;
		} catch {
			check(
				performance.now() < deadline,
				`The client did not capture ${phase}`,
			);
			await new Promise((done) => setTimeout(done, 100));
		}
	}
}

/** Inside the real App in WKWebView: the Work view's detail for an agent
 * that manages a few, five and many agents and for one that manages nobody,
 * in light and dark, folded, and pinned beside another, and for ended agents
 * with a short and a long last conversation. */
async function run(report: (phase: string, facts?: object) => void) {
	const home = await homeDir();
	check(
		home.includes("/dure-work-detail-layout.") && home.endsWith("/home"),
		"Work detail QA escaped its disposable HOME",
	);
	const fixture = JSON.parse(
		(await readFile(`${home}/work-detail-fixture.json`)).content,
	) as Fixture;
	await waitFor("The agent registry did not hydrate", () =>
		useStore.persist.hasHydrated(),
	);
	useStore.setState((state) => ({
		agents: [...state.agents, ...fixture.agents],
	}));
	useWorkViewStore.getState().setManagedOpen(true);
	useWindowSidebarStore.getState().setTab("work");
	const [few, five, many] = fixture.leads;
	const { solo } = fixture;
	const [endedFew, endedMany] = fixture.ended;
	const show = (selected: string, theme: "light" | "dark") => () => {
		useWorkViewStore.getState().select(selected);
		useStore.getState().setUiPrefs({ theme });
	};
	let headerBeforeFold: number | undefined;

	/** The window shows `phase`'s theme and keeps it for half a second: the
	 * app may still apply its saved appearance just after it starts. */
	const holdTheme = async (phase: string) => {
		const theme = phase.endsWith("-dark") ? "dark" : "light";
		let steady = 0;
		await waitFor(`The ${phase} theme did not hold`, () => {
			if (useStore.getState().uiPrefs?.theme !== theme) {
				useStore.getState().setUiPrefs({ theme });
			}
			const shown =
				document.documentElement.classList.contains("dark") ===
				(theme === "dark");
			steady = shown ? steady + 1 : 0;
			return steady >= 10;
		});
	};

	/** An ended agent's phase settles once its last message has rendered. */
	const ended = (key: string, texts: readonly string[]) => ({
		expected: texts,
		settled: () => columnFacts(key, texts).transcript.shows.every(Boolean),
	});
	const phases: [
		string,
		string,
		() => void | Promise<void>,
		ReturnType<typeof ended>?,
	][] = [
		["five-light", five, show(five, "light")],
		["five-dark", five, show(five, "dark")],
		["few-light", few, show(few, "light")],
		["few-dark", few, show(few, "dark")],
		["many-light", many, show(many, "light")],
		["many-dark", many, show(many, "dark")],
		["empty-light", solo, show(solo, "light")],
		["empty-dark", solo, show(solo, "dark")],
		[
			"many-folded-dark",
			many,
			async () => {
				show(many, "dark")();
				await waitFor("The many-agent lead did not show", () =>
					Boolean(column(many)?.querySelector("details")?.open),
				);
				await painted();
				headerBeforeFold = headerBottom(many);
				column(many)
					?.querySelector<HTMLElement>('[data-slot="work-managed"] summary')
					?.click();
			},
		],
		[
			"ended-few-light",
			endedFew,
			show(endedFew, "light"),
			ended(endedFew, ENDED_TEXT.few),
		],
		[
			"ended-few-dark",
			endedFew,
			show(endedFew, "dark"),
			ended(endedFew, ENDED_TEXT.few),
		],
		[
			"ended-many-light",
			endedMany,
			show(endedMany, "light"),
			ended(endedMany, ENDED_TEXT.many),
		],
		[
			"ended-many-dark",
			endedMany,
			show(endedMany, "dark"),
			ended(endedMany, ENDED_TEXT.many),
		],
		[
			"pinned-light",
			five,
			() => {
				show(solo, "light")();
				useWorkViewStore.getState().pin(five);
				useWorkViewStore.getState().setManagedOpen(true);
			},
		],
	];
	for (const [phase, key, apply, transcript] of phases) {
		await apply();
		await holdTheme(phase);
		// The app reads each worker's last prompt from its transcript on its
		// own; a phase is measured once every open row shows it.
		await waitFor(
			`The ${phase} layout did not settle`,
			() => {
				const root = column(key);
				if (!root) return false;
				if (transcript && !transcript.settled()) return false;
				const fold = root.querySelector("details");
				if (!fold) return true;
				if (fold.open !== useWorkViewStore.getState().managedOpen) return false;
				const shown = columnFacts(key).managed;
				return !fold.open || Boolean(shown?.activities.every(Boolean));
			},
			60_000,
		);
		dismissNotices();
		await painted();
		report(phase, {
			managedOpen: useWorkViewStore.getState().managedOpen,
			...(phase === "many-folded-dark"
				? { headerBeforeFold, headerAfterFold: headerBottom(key) }
				: {}),
			...facts(key, solo, transcript?.expected),
		});
		await captured(home, phase);
	}
	report("done");
}

function headerBottom(key: string): number | undefined {
	return column(key)?.querySelector("header")?.getBoundingClientRect().bottom;
}

export async function runWorkDetailLayoutProbe() {
	const proof = new URLSearchParams(location.search).get("qaWorkDetailLayout");
	if (!import.meta.env.DEV || !proof) return;
	const report = (phase: string, facts: object = {}) =>
		qaLog(`work-detail-layout-${phase}`, { proof, ...facts });
	try {
		report("started");
		await run(report);
	} catch (error) {
		report("failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
