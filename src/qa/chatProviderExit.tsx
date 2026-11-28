import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AgentChatSurface } from "@/components/agents/chat/AgentChatSurface";
import { useChatContentTypography } from "@/components/agents/chat/useChatContentTypography";
import type {
	AgentChatProviderResume,
	AgentChatSessionView,
} from "@/lib/agents/chat/agentChatSessionView";
import type { AgentTimelineRowV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { readFile } from "@/lib/ipc/files";
import { qaLog } from "@/lib/qa/qaLog";
import { useStore } from "@/store";

/** The composer of a Chat Agent whose Claude exited, in each state of its
 * Resume, drawn by the real chat surface on the real tokens in WKWebView.
 * The session view is a fixture: no backend, provider or submission runs. */

const identity = {
	agentId: "qa-provider-exit",
	backendProfileId: "local",
	interactionSessionId: "qa-provider-exit-conversation",
};
const EXIT_ITEM = "qa-exit";
const DRAFT = "Also update the README example.";

function row(
	sequence: number,
	itemId: string,
	body: AgentTimelineRowV1["item"]["body"],
): AgentTimelineRowV1 {
	return {
		cursor: { epoch: "qa-timeline", sequence },
		item: {
			itemId,
			turnId: null,
			clientMessageId: null,
			providerMessageId: null,
			createdAtMs: sequence,
			body,
		},
	};
}

const ROWS: AgentTimelineRowV1[] = [
	row(1, "qa-ready", {
		type: "lifecycle",
		state: "session_ready",
		detail: null,
	}),
	row(2, "qa-ask", {
		type: "message",
		role: "user",
		markdown: "Rename `loadConfig` to `readConfig` and update its callers.",
	}),
	row(3, "qa-answer", {
		type: "message",
		role: "assistant",
		markdown:
			"Renamed `loadConfig` to `readConfig` in six files and updated the two tests that import it. The test suite passes.",
	}),
	row(4, EXIT_ITEM, {
		type: "lifecycle",
		state: "session_exited",
		detail: '{"code":143,"signal":null}',
	}),
];

const PHASES: ReadonlyArray<
	readonly [name: string, resume: AgentChatProviderResume | undefined]
> = [
	["ended", undefined],
	["resuming", { exitItemId: EXIT_ITEM, state: "resuming" }],
	["did-not-restart", { exitItemId: EXIT_ITEM, state: "not_restarted" }],
	[
		"refused",
		{
			exitItemId: EXIT_ITEM,
			state: "failed",
			refusal: {
				code: "agent_conversation_conflict",
				message: "agent_conversation_conflict",
			},
		},
	],
];

const noop = async () => {};

function sessionView(
	providerResume: AgentChatProviderResume | undefined,
): AgentChatSessionView {
	return {
		draftIdentity: identity,
		phase: "ready",
		reconnecting: false,
		sending: false,
		savingGoal: false,
		retryTurnAvailable: false,
		interrupting: false,
		loadingOlder: false,
		queuedMessages: [],
		providerResume,
		page: {
			binding: {
				schemaVersion: 1,
				interactionSessionId: identity.interactionSessionId,
				agentId: identity.agentId,
				providerId: "claude",
				executionProfile: { kind: "provider_default" },
				providerConversationRef: "qa-claude-session",
				runtime: { runtimeGeneration: "qa-runtime", providerEpoch: "qa-query" },
				timelineEpoch: "qa-timeline",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: ROWS,
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			recovery: null,
			latestFailure: null,
			goal: null,
			finalCursor: { epoch: "qa-timeline", sequence: ROWS.length },
			hasMore: false,
		},
		putGoal: async () => true,
		retryConnection: () => {},
		loadOlder: noop,
		readProviderHistory: async () => null,
		send: noop,
		retryTurn: noop,
		editRetryableTurn: async () => undefined,
		answerPending: noop,
		interrupt: noop,
		resumeProvider: noop,
		dismissActionError: () => {},
		loadMoreQueued: noop,
		queueMessage: noop,
		steerOrQueue: async () => "queued",
		dequeueMessage: async () => "",
	};
}

let current = sessionView(undefined);
const listeners = new Set<() => void>();
function show(resume: AgentChatProviderResume | undefined) {
	current = sessionView(resume);
	for (const listener of listeners) listener();
}

function ProbeSurface() {
	const session = useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => current,
	);
	const typography = useChatContentTypography();
	return (
		<div
			data-qa-provider-exit
			className="fixed inset-0 z-[2147483647] flex flex-col"
			style={{ background: typography.background }}
		>
			<AgentChatSurface session={session} typography={typography} />
		</div>
	);
}

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

const painted = () =>
	new Promise((done) =>
		requestAnimationFrame(() => requestAnimationFrame(done)),
	);

/** The window shows `theme` and keeps it for half a second: the app may
 * still apply its saved appearance just after it starts. */
async function holdTheme(theme: "light" | "dark") {
	let steady = 0;
	await waitFor(`The ${theme} theme did not hold`, () => {
		if (useStore.getState().uiPrefs?.theme !== theme)
			useStore.getState().setUiPrefs({ theme });
		const shown =
			document.documentElement.classList.contains("dark") ===
			(theme === "dark");
		steady = shown ? steady + 1 : 0;
		return steady >= 10;
	});
}

const color = (element: Element | null | undefined) =>
	element ? getComputedStyle(element).color : null;

/** The colour a token class resolves to on this surface. */
function tokenColor(surface: Element, className: string) {
	const sample = document.createElement("span");
	sample.className = className;
	surface.append(sample);
	const resolved = getComputedStyle(sample).color;
	sample.remove();
	return resolved;
}

/** What the notice shows, measured the way a person sees it. */
function noticeFacts() {
	const surface = document.querySelector("[data-qa-provider-exit]");
	const input = surface?.querySelector("textarea");
	const strip = surface?.querySelector<HTMLElement>("[data-slot=alert]");
	check(input && strip, "The composer or its notice is missing");
	const box = strip.parentElement;
	const style = getComputedStyle(strip);
	const [ended, outcome] = Array.from(
		strip.querySelectorAll<HTMLElement>("[data-slot=alert-description] > span"),
	);
	const button = strip.querySelector("button");
	return {
		dark: document.documentElement.classList.contains("dark"),
		insideComposerBox: Boolean(box?.contains(input)),
		boxBorderTop: box ? getComputedStyle(box).borderTopWidth : null,
		borders: {
			top: style.borderTopWidth,
			right: style.borderRightWidth,
			bottom: style.borderBottomWidth,
			left: style.borderLeftWidth,
		},
		background: style.backgroundColor,
		tokens: {
			foreground: tokenColor(strip, "text-foreground"),
			muted: tokenColor(strip, "text-muted-foreground"),
			attention: tokenColor(strip, "text-status-warn"),
		},
		colors: {
			ended: color(ended),
			outcome: color(outcome),
			glyph: color(strip.querySelector("[data-slot=alert-glyph]")),
			action: color(button),
		},
		ended: ended?.textContent ?? null,
		endedDetail: ended?.querySelector("code")?.textContent ?? null,
		outcome: outcome?.textContent ?? null,
		action: {
			label: button?.textContent ?? null,
			disabled: button?.disabled ?? null,
		},
		draft: input.value,
		expected: {
			ended: t("agents.chat.providerExited"),
			resume: t("agents.chat.resumeSession"),
			resuming: t("agents.chat.resumingSession"),
			notRestarted: t("agents.chat.resumeNotRestarted"),
			refused: t("agents.chat.resumeFailed", {
				reason: t("agents.chat.error.conflict"),
			}),
		},
	};
}

async function captured(home: string, phase: string) {
	const deadline = performance.now() + 180_000;
	for (;;) {
		try {
			await readFile(`${home}/chat-provider-exit-captured-${phase}`);
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

async function run(report: (phase: string, facts?: object) => void) {
	const home = await homeDir();
	check(
		home.includes("/dure-chat-provider-exit.") && home.endsWith("/home"),
		"Provider exit QA escaped its disposable HOME",
	);
	await waitFor("The store did not hydrate", () =>
		useStore.persist.hasHydrated(),
	);
	useStore.getState().updateChatDraft(identity, () => ({
		text: DRAFT,
		attachments: [],
	}));
	const element = document.createElement("div");
	document.body.append(element);
	createRoot(element).render(<ProbeSurface />);
	report("started");
	for (const theme of ["light", "dark"] as const) {
		for (const [name, resume] of PHASES) {
			const phase = `${name}-${theme}`;
			show(resume);
			await holdTheme(theme);
			await painted();
			report(phase, noticeFacts());
			await captured(home, phase);
		}
	}
	report("done");
}

export async function runChatProviderExitProbe() {
	const proof = new URLSearchParams(location.search).get("qaChatProviderExit");
	if (!import.meta.env.DEV || !proof) return;
	const report = (phase: string, facts: object = {}) =>
		qaLog(`chat-provider-exit-${phase}`, { proof, ...facts });
	try {
		await run(report);
	} catch (error) {
		report("failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
