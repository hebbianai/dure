import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { QuickDispatchOverlay } from "@/components/agents/quickDispatch/QuickDispatchOverlay";
import { AddAgentBody } from "@/components/agents/addAgent/AddAgentBody";
import { t } from "@/lib/i18n";
import { gitExecLocal, homeDir } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import { durableAppStorage, DURABLE_APP_STORE_NAME, useStore } from "@/store";
import type { Project } from "@/types";

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
async function wait(check: () => boolean) {
	const deadline = Date.now() + 15_000;
	while (!check()) {
		if (Date.now() > deadline)
			throw new Error(`Repository QA timed out: ${document.body.textContent}`);
		await pause();
	}
}
const toggle = () =>
	document.querySelector<HTMLButtonElement>('[role="switch"]');

/** Real native Git, persistence and both launch forms, in a disposable offscreen
 * WebView. No provider starts, worktrees, or user input/focus are involved. */
export async function runProjectRepositoryFixture(root: Root, proof: string) {
	try {
		await useStore.persist.rehydrate();
		const home = await homeDir();
		if (
			!home.includes("/dure-project-repository.") ||
			!home.endsWith("/home")
		) {
			throw new Error("Repository QA requires its isolated HOME");
		}
		const project: Project = {
			id: "qa-repo",
			name: "QA project",
			path: `${home}/repo`,
			kind: "local",
			isRepo: false,
		};
		useStore.setState({
			projects: [project],
			agents: [],
			accounts: [],
			activeAccounts: {},
			installedAgents: ["codex"],
		});
		await durableAppStorage.flush();
		const showQuick = (projectId: string, key: string) =>
			flushSync(() =>
				root.render(
					<QuickDispatchOverlay
						key={key}
						open
						onClose={() => {}}
						prefill={{
							projectId,
							promptText: "Keep this draft",
							typedName: "",
						}}
					/>,
				),
			);
		showQuick(project.id, "stale");
		const beforeDisabled = toggle()?.disabled === true;
		await wait(() => toggle()?.disabled === false);
		const recovered = useStore.getState().projects[0];
		toggle()!.click();
		await wait(() => toggle()?.getAttribute("aria-checked") === "true");
		const draftPreserved =
			document.querySelector("textarea")?.value === "Keep this draft";
		await durableAppStorage.flush();
		const persisted = await durableAppStorage.read(
			DURABLE_APP_STORE_NAME,
			(saved) => saved?.state.projects[0],
		);

		// The full form must consume the refreshed stored object as well.
		flushSync(() => root.render(null));
		useStore.setState({ projects: [project] });
		await durableAppStorage.flush();
		flushSync(() =>
			root.render(
				<AddAgentBody
					desktopId={useStore.getState().activeSpaceId}
					initialHostId={null}
					onClose={() => {}}
					onBrowse={() => {}}
					onAddHost={() => {}}
				/>,
			),
		);
		await wait(() =>
			Boolean(
				document.querySelector(
					`button[role="switch"][aria-label="${t("agents.worktree.isolateDedicated")}"]`,
				),
			),
		);
		const fullFormRecovered = useStore.getState().projects[0]?.isRepo === true;

		const plain: Project = {
			...project,
			id: "plain",
			path: `${home}/plain`,
			name: "Plain folder",
		};
		useStore.setState({ projects: [plain] });
		showQuick(plain.id, "plain");
		await wait(
			() =>
				document.body.textContent?.includes(t("agents.worktree.notGitRepo")) ===
				true,
		);
		const plainDisabled = toggle()?.disabled === true;
		const initialized = await gitExecLocal(plain.path, ["init", "--quiet"]);
		if (initialized.code !== 0) throw new Error(initialized.stderr);
		const retry = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === t("panels.git.availability.recheck"),
		);
		if (!retry) throw new Error("Missing repository retry action");
		retry.click();
		await wait(() => toggle()?.disabled === false);
		const retryRecovered = useStore.getState().projects[0]?.isRepo === true;

		const missing = {
			...plain,
			id: "missing",
			path: `${home}/missing`,
			name: "Unavailable folder",
		};
		useStore.setState({ projects: [missing] });
		showQuick(missing.id, "unknown");
		await wait(
			() =>
				document.body.textContent?.includes(
					t("agents.worktree.repositoryUnknown"),
				) === true,
		);
		const unknownDistinct = !document.body.textContent?.includes(
			t("agents.worktree.notGitRepo"),
		);
		const passed =
			beforeDisabled &&
			recovered?.id === project.id &&
			recovered.isRepo &&
			persisted?.isRepo &&
			draftPreserved &&
			fullFormRecovered &&
			plainDisabled &&
			retryRecovered &&
			unknownDistinct &&
			useStore.getState().agents.length === 0;
		qaLog("project-repository", {
			proof,
			passed,
			beforeDisabled,
			draftPreserved,
			fullFormRecovered,
			plainDisabled,
			retryRecovered,
			unknownDistinct,
			persisted: persisted?.isRepo,
			userAgent: navigator.userAgent,
		});
	} catch (error) {
		qaLog("project-repository", { proof, passed: false, error: String(error) });
	}
}
