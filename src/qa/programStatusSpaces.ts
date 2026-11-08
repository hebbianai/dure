import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import {
	DEFAULT_SPACES_VIEW_OPTIONS,
	type SpacesGrouping,
} from "@/lib/spaces/spacesViewOptions";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { createHmuxStandaloneTerminalOn } from "@/lib/workspace/dock/standaloneShellTerminal";
import { useStore } from "@/store";

const ROLLUP = "[data-space-program-status-rollup]";

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(message: string, ready: () => boolean, timeoutMs = 30_000) {
	const deadline = performance.now() + timeoutMs;
	while (!ready()) {
		check(performance.now() < deadline, message);
		await new Promise((done) => setTimeout(done, 50));
	}
}

function setGrouping(groupBy: SpacesGrouping) {
	const state = useStore.getState();
	state.setUiPrefs({
		spacesViewOptions: {
			...(state.uiPrefs?.spacesViewOptions ?? DEFAULT_SPACES_VIEW_OPTIONS),
			groupBy,
		},
	});
}

/** Inside the real App in WKWebView: a Hmux standalone pane, which is not a
 * registered Agent, runs a program whose real OSC 7501 bytes cross the Host and
 * its stream while the pane's Space is off-screen. */
async function run(report: (phase: string, facts?: object) => void) {
	const home = await homeDir();
	check(
		home.includes("/dure-program-status-spaces.") && home.endsWith("/home"),
		"Program status QA escaped its disposable HOME",
	);
	await waitFor("The workspace did not mount", () =>
		Boolean(getDockview(useStore.getState().activeSpaceId)),
	);
	const origin = useStore.getState().activeSpaceId;
	const elsewhere = useStore.getState().addSpace({ name: "Waiting work" });
	await waitFor("The second Space did not mount", () =>
		Boolean(getDockview(elsewhere)),
	);
	const dockview = getDockview(elsewhere);
	check(dockview, "The second Space lost its Dockview");
	const session = await createHmuxStandaloneTerminalOn(
		dockview,
		home,
		undefined,
		undefined,
		elsewhere,
		{
			commandLine: `'${home}/.local/bin/codex-program-status-fixture' '${home}/program-status-fixture.mjs'`,
		},
	);
	const runtime = () =>
		useStore.getState().sessionAgentRuntimeState[session.sessionId];
	await waitFor("The Host did not identify a running provider", () =>
		runtime()?.lifecycle === "running",
	);
	useStore.getState().setActiveSpace(origin);
	const row = () =>
		document.querySelector(`[data-space-key="${CSS.escape(session.panelId)}"]`);
	await waitFor("The Spaces row did not render", () => row() !== null);

	const label = t("agents.programStatus.permission");
	const rollups = () =>
		[...document.querySelectorAll(ROLLUP)].map((element) =>
			element.getAttribute("aria-label"),
		);
	const spaceHeadingRollup = () =>
		document
			.querySelector(`[data-space-desktop-section="${CSS.escape(elsewhere)}"] ${ROLLUP}`)
			?.getAttribute("aria-label") ?? null;
	const facts = () => {
		const attention = useAgentAttention.getState();
		return {
			label,
			expectedRollup: t("spaces.group.programStatusCount", { n: 1 }),
			activeSpace: useStore.getState().activeSpaceId,
			paneSpace: elsewhere,
			isRegisteredAgent: useStore
				.getState()
				.agents.some((agent) => agent.sessionId === session.sessionId),
			rowText: row()?.textContent ?? null,
			rowHasBadge: row()?.textContent?.includes(label) ?? false,
			rollups: rollups(),
			spaceHeadingRollup: spaceHeadingRollup(),
			hostAttention: runtime()?.attention ?? null,
			programStatus: runtime()?.programStatus ?? null,
			attentionDisplayStates: Object.keys(attention.displayStates),
			attentionEpisodes: Object.keys(attention.episodes),
			nextUpChip:
				document.querySelector(
					`[aria-label^="${CSS.escape(t("agents.nextUp.open"))}"]`,
				) !== null,
		};
	};
	report("ready", facts());

	await waitFor(
		"The waiting report did not reach the Spaces row",
		() => facts().rowHasBadge && rollups().length > 0,
		60_000,
	);
	const repositoryGrouping = facts();
	setGrouping("space");
	await waitFor("The Space heading did not roll the report up", () =>
		spaceHeadingRollup() !== null && rollups().length === 1,
	);
	const spaceGrouping = facts();
	setGrouping("repository");
	await waitFor("The repository grouping did not return", () =>
		rollups().length === repositoryGrouping.rollups.length,
	);
	report("blocked", { repositoryGrouping, spaceGrouping });

	await waitFor(
		"The report did not clear from the Spaces row",
		() => !facts().rowHasBadge && rollups().length === 0,
		60_000,
	);
	report("cleared", facts());
}

export async function runProgramStatusSpacesProbe() {
	const proof = new URLSearchParams(location.search).get("qaProgramStatusSpaces");
	if (!import.meta.env.DEV || !proof) return;
	const report = (phase: string, facts: object = {}) =>
		qaLog(`program-status-spaces-${phase}`, { proof, ...facts });
	try {
		await run(report);
	} catch (error) {
		report("failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
