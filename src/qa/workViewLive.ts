import { spawnAgent } from "@/lib/cli/cliServer";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { readFile } from "@/lib/ipc/files";
import { qaLog } from "@/lib/qa/qaLog";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useWorkViewStore } from "@/lib/work/workViewStore";
import { useStore } from "@/store";

/** What work-view-live-home-setup.mjs wrote: the project the agent works in
 * and the turns the stand-in API answers, step by step. */
interface Fixture {
	project: string;
	turns: { prompt: string; steps: { text: string }[] }[];
}

/** One look at the Work detail while a turn runs: how many of the turn's
 * steps it shows, and whether the Host still reports the agent working. */
interface Sample {
	at: number;
	working: boolean;
	steps: number;
}

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(
	message: string,
	ready: () => boolean,
	timeoutMs = 30_000,
	describe: () => object = () => ({}),
) {
	const deadline = performance.now() + timeoutMs;
	while (!ready()) {
		if (performance.now() >= deadline) {
			throw new Error(`${message}: ${JSON.stringify(describe())}`);
		}
		dismissNotices();
		await new Promise((done) => setTimeout(done, 50));
	}
}

/** A fresh home raises the first-run tooling notice; the probe closes it the
 * way a person would, so it covers no capture. */
function dismissNotices() {
	const close = JSON.stringify(t("common.close"));
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		`section > div > button[aria-label=${close}]`,
	)) {
		button.click();
	}
}

async function marker(home: string, name: string, timeoutMs = 180_000) {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		dismissNotices();
		try {
			await readFile(`${home}/${name}`);
			return;
		} catch {
			check(performance.now() < deadline, `No ${name}`);
			await new Promise((done) => setTimeout(done, 100));
		}
	}
}

/** The window shows `theme` and keeps it for half a second: the app may
 * still apply its saved appearance just after it starts. */
async function holdTheme(theme: "light" | "dark") {
	let steady = 0;
	await waitFor(`The ${theme} theme did not hold`, () => {
		if (useStore.getState().uiPrefs?.theme !== theme) {
			useStore.getState().setUiPrefs({ theme });
		}
		const shown =
			document.documentElement.classList.contains("dark") ===
			(theme === "dark");
		steady = shown ? steady + 1 : 0;
		return steady >= 10;
	});
}

function conversationOf(agentId: string): HTMLElement | null {
	return (
		document
			.querySelector<HTMLElement>(`[data-work-column="${CSS.escape(agentId)}"]`)
			?.querySelector<HTMLElement>('[data-slot="work-conversation"]') ?? null
	);
}

function working(agentId: string): boolean {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	return (
		!!agent &&
		state.sessionAgentRuntimeState[agent.sessionId]?.activity === "working"
	);
}

/** The newest of the turn's steps the conversation shows; a virtualized row
 * scrolled away above it no longer has its text in the document. */
function stepsShown(agentId: string, steps: readonly { text: string }[]) {
	const text = conversationOf(agentId)?.textContent ?? "";
	for (let index = steps.length - 1; index >= 0; index -= 1) {
		if (text.includes(steps[index]?.text ?? "\u0000")) return index + 1;
	}
	return 0;
}

function describeAgent(agentId: string) {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	return {
		runtime: agent ? state.sessionAgentRuntimeState[agent.sessionId] : null,
		binding: agent?.runtimeBinding?.runtime,
		conversation: conversationOf(agentId)?.textContent?.slice(-600) ?? null,
	};
}

/** Sends from the Work detail's composer the way a person does. */
async function sendFromComposer(agentId: string, prompt: string) {
	const send = () =>
		conversationOf(agentId)?.querySelector<HTMLButtonElement>(
			`button[aria-label=${JSON.stringify(t("agents.chat.send"))}]`,
		);
	const composer = () =>
		conversationOf(agentId)?.querySelector<HTMLTextAreaElement>("textarea");
	await waitFor(
		"The composer did not open at the idle prompt",
		() => Boolean(composer() && !working(agentId)),
		60_000,
		() => describeAgent(agentId),
	);
	const textarea = composer();
	check(textarea, "The composer went away");
	Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set?.call(textarea, prompt);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	await waitFor("Send did not enable", () => send()?.disabled === false);
	send()?.click();
}

/** One turn as the Work detail shows it: from the prompt while the Host
 * reports the agent working until its last step shows after it ended. */
async function followTurn(
	agentId: string,
	turn: Fixture["turns"][number],
	theme: "light" | "dark",
	report: (phase: string, facts?: object) => void,
) {
	await waitFor(
		`The ${theme} turn did not start in the Work detail`,
		() =>
			working(agentId) &&
			Boolean(conversationOf(agentId)?.textContent?.includes(turn.prompt)),
		180_000,
		() => describeAgent(agentId),
	);
	report(`${theme}-working`);
	const timeline: Sample[] = [];
	const sample = () => {
		const next = {
			at: Date.now(),
			working: working(agentId),
			steps: stepsShown(agentId, turn.steps),
		};
		const last = timeline[timeline.length - 1];
		if (!last || last.working !== next.working || last.steps !== next.steps) {
			timeline.push(next);
		}
		return next;
	};
	await waitFor(
		`The ${theme} turn did not finish in the Work detail`,
		() => {
			const now = sample();
			return !now.working && now.steps === turn.steps.length;
		},
		180_000,
		() => ({ ...describeAgent(agentId), timeline }),
	);
	report(`${theme}-ended`, {
		timeline,
		dark: document.documentElement.classList.contains("dark"),
	});
}

/** Inside the real App in WKWebView: a real Claude Code agent, started the
 * way `dure runs` starts one, works through two multi-step turns while the
 * Work detail shows it; the client captures frames as each step arrives. */
async function run(report: (phase: string, facts?: object) => void) {
	const home = await homeDir();
	check(
		home.includes("/dure-work-view-live.") && home.endsWith("/home"),
		"Work view live QA escaped its disposable HOME",
	);
	const fixture = JSON.parse(
		(await readFile(`${home}/work-view-live-fixture.json`)).content,
	) as Fixture;
	const [first, second] = fixture.turns;
	check(first && second, "The fixture has no two turns");
	await waitFor("The agent registry did not hydrate", () =>
		useStore.persist.hasHydrated(),
	);
	useStore.setState({
		projects: [
			{
				id: "qa-live-project",
				name: "release-tools",
				path: fixture.project,
				kind: "local",
				isRepo: false,
			},
		],
	});
	await marker(home, "work-view-live-api-ready");
	await holdTheme("light");
	const agent = await spawnAgent({
		project: "qa-live-project",
		provider: "claude",
		name: "release-walkthrough",
		prompt: first.prompt,
		useWorktree: false,
	});
	useWindowSidebarStore.getState().setTab("work");
	useWorkViewStore.getState().select(agent.id);
	await followTurn(agent.id, first, "light", report);
	await marker(home, "work-view-live-captured-light");

	await holdTheme("dark");
	await sendFromComposer(agent.id, second.prompt);
	await followTurn(agent.id, second, "dark", report);
	await marker(home, "work-view-live-captured-dark");
	report("done");
}

export async function runWorkViewLiveProbe() {
	const proof = new URLSearchParams(location.search).get("qaWorkViewLive");
	if (!import.meta.env.DEV || !proof) return;
	const report = (phase: string, facts: object = {}) =>
		qaLog(`work-view-live-${phase}`, { proof, ...facts });
	try {
		report("started");
		await run(report);
	} catch (error) {
		report("failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
