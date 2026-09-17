import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { SpacesRepositoryActions } from "@/components/spaces/SpacesRepositoryActions";
import { useRepositoryQuickAdd } from "@/components/spaces/useRepositoryQuickAdd";
import { Toaster } from "@/components/Toaster";
import { Workspace } from "@/components/workspace/Workspace";
import { t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openSplitLauncherPanel } from "@/lib/workspace/pane/paneSplit";
import { durableAppStorage, useStore } from "@/store";
import { PROVIDERS } from "@/types";
import { observeQuickStartPresentation } from "./repositoryQuickStartPresentation";

const proof = new URLSearchParams(location.search).get(
	"qaRepositoryQuickStart",
);
const invalidProfile =
	new URLSearchParams(location.search).get("scenario") === "invalid-profile";
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

/** Disposable offscreen WebView: real rail, native preparation, canonical Run
 * and provider presentation. Only native modal acknowledgement is intercepted;
 * the window cannot take OS focus and no provider input is injected. */
export function RepositoryQuickStartQaRoot() {
	const [fixture, setFixture] = useState<{ path: string; spaceId: string }>();
	const settled = useRef(0);
	const handlers = useRepositoryQuickAdd(() => {
		qaLog("repository-quick-start-options", { proof });
	});
	useEffect(() => {
		if (!proof) return;
		let stopped = false;
		const run = async () => {
			await useStore.persist.rehydrate();
			const home = await homeDir();
			if (
				!home.includes("/dure-repository-quick-start.") ||
				!home.endsWith("/home")
			)
				throw new Error("Quick-start QA escaped its disposable HOME");
			const spaceId = useStore
				.getState()
				.addSpace({ name: "Quick-start QA", activate: true });
			const agentPane = (agentId: string) => {
				const api = getDockview(spaceId);
				return api && findAgentPanel(api, agentId);
			};
			const path = `${home}/quick-start-repo`;
			useStore.setState({
				accounts: invalidProfile
					? [
							{
								id: "qa-missing-profile",
								provider: "claude",
								name: "Missing QA profile",
								dir: "qa-missing-profile",
							},
						]
					: [],
				activeAccounts: invalidProfile ? { claude: "qa-missing-profile" } : {},
				installedAgents: ["claude", "codex"],
			});
			await durableAppStorage.flush();
			const original = window.fetch;
			const events: Array<{
				command: string;
				operation?: string;
				state: string;
				ms: number;
			}> = [];
			const pending = new Set<string>();
			const started = performance.now();
			let error: string | undefined;
			let acknowledge: (() => void) | undefined;
			window.fetch = async (
				...args: Parameters<typeof fetch>
			): Promise<Response> => {
				const endpoint = String(args[0]);
				const command = decodeURIComponent(
					endpoint.slice(endpoint.lastIndexOf("/") + 1),
				);
				if (
					!/^(git_|codex_trust_workspace|dure_backend_|plugin:dialog|hmux_session_inspect|hmux_managed_shell_create|hmux_standalone_create)/.test(
						command,
					)
				)
					return original.apply(window, args);
				const body =
					typeof args[1]?.body === "string" ? JSON.parse(args[1].body) : {};
				const operation =
					typeof body.operation === "string" ? body.operation : undefined;
				const key = `${command}:${operation ?? ""}`;
				const record = (state: string) => {
					if (events.length < 128)
						events.push({
							command,
							operation,
							state,
							ms: Math.round(performance.now() - started),
						});
				};
				record("started");
				pending.add(key);
				try {
					if (command === "plugin:dialog|message") {
						error = String(body.message);
						if (invalidProfile)
							await new Promise<void>((resolve) => {
								acknowledge = resolve;
							});
						return new Response("null", {
							headers: {
								"content-type": "application/json",
								"Tauri-Response": "ok",
							},
						});
					}
					const result = await original.apply(window, args);
					record(result.headers.get("Tauri-Response") ?? String(result.status));
					return result;
				} catch (cause) {
					record("rejected");
					throw cause;
				} finally {
					pending.delete(key);
				}
			};
			const presentation = observeQuickStartPresentation(spaceId);
			try {
				setFixture({ path, spaceId });
				const deadline = performance.now() + (invalidProfile ? 5_000 : 60_000);
				let button: HTMLButtonElement | undefined;
				while (!button || !getDockview(spaceId)) {
					if (performance.now() > deadline)
						throw new Error("QA rail or desktop did not mount");
					button = [...document.querySelectorAll("button")].find(
						(item) =>
							item.getAttribute("aria-label") ===
							t("spaces.repository.startWith", {
								label: PROVIDERS.claude.label,
							}),
					);
					await delay();
				}
				button.click();
				await delay();
				while (settled.current === 0 && performance.now() < deadline)
					await delay();
				await delay();
				const agents = useStore.getState().agents;
				const feedbackPrefix = t("spaces.repository.startFailed", {
					e: "",
				}).trim();
				const feedbackText = [...document.querySelectorAll("[role=alert]")].map(
					(node) => node.textContent ?? "",
				);
				const feedbackVisible = feedbackText.some((text) =>
					text.includes(feedbackPrefix),
				);
				const firstFailure = {
					elapsedMs: Math.round(performance.now() - started),
					busy: button.disabled,
					feedbackVisible,
					settled: settled.current,
				};
				let recovery: Record<string, boolean> | undefined;
				let launcher: { feedbackMs: number; presentedMs: number } | undefined;
				if (
					invalidProfile &&
					settled.current > 0 &&
					feedbackVisible &&
					!button.disabled
				) {
					const wait = async (
						description: string,
						ready: () => boolean,
						timeout = 5_000,
					) => {
						const until = performance.now() + timeout;
						while (!ready()) {
							if (performance.now() > until)
								throw new Error(`Quick-start QA: ${description}`);
							await delay();
						}
						await delay();
					};
					button.click();
					await wait("retry did not settle", () => settled.current === 2);
					useStore.setState({
						accounts: [
							{
								id: "qa-invalid-codex",
								provider: "codex",
								name: "Invalid QA",
								dir: "invalid",
							},
						],
						activeAccounts: { codex: "qa-invalid-codex" },
					});
					const menu = [...document.querySelectorAll("button")].find(
						(item) =>
							item.getAttribute("aria-label") ===
							t("spaces.repository.addTo", { name: "Quick-start QA" }),
					);
					if (!menu) throw new Error("Quick-start QA menu missing");
					menu.dispatchEvent(
						new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
					);
					const menuEntry = () =>
						[...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
							(item) =>
								item.textContent?.trim() ===
								t("spaces.repository.startWith", {
									label: PROVIDERS.codex.label,
								}),
						);
					await wait("provider menu did not open", () => Boolean(menuEntry()));
					menuEntry()!.click();
					await wait(
						"menu failure did not settle",
						() => settled.current === 3,
					);
					const api = getDockview(spaceId)!;
					const before = new Set(api.panels.map((panel) => panel.id));
					const terminal = [...document.querySelectorAll("button")].find(
						(item) =>
							item.getAttribute("aria-label") === t("common.openTerminal"),
					);
					if (!terminal)
						throw new Error("Quick-start QA terminal action missing");
					terminal.click();
					await wait("terminal pane missing", () =>
						api.panels.some(
							(panel) =>
								!before.has(panel.id) &&
								panel.api.component === "terminal" &&
								panel.params?.cwd === path,
						),
					);
					if (useStore.getState().agents.length !== 0)
						throw new Error("Rejected launches created an Agent");
					const source = api.activePanel!;
					const existingPanes = new Map(
						api.panels.map((panel) => [panel.id, panel]),
					);
					flushSync(() =>
						openSplitLauncherPanel(
							spaceId,
							{ kind: "local", cwd: path },
							{
								referencePanel: source.id,
								direction: "right",
							},
						),
					);
					const selector = api.activePanel!;
					const launch = document.querySelector<HTMLButtonElement>(
						"[data-launcher-row]",
					);
					if (!launch || selector.api.component !== "launcher")
						throw new Error("Quick-start QA launcher did not mount");
					const launchStarted = performance.now();
					flushSync(() => launch.click());
					if (
						!launch.disabled ||
						launch.getAttribute("aria-busy") !== "true" ||
						!launch.querySelector("[role=status]")
					)
						throw new Error(
							"Quick-start QA launcher did not show pending creation",
						);
					const feedbackMs = Math.round(performance.now() - launchStarted);
					launch.click();
					await wait(
						"launcher terminal did not replace its slot",
						() => api.getPanel(selector.id)?.api.component === "terminal",
					);
					qaLog("repository-quick-start-launcher", {
						proof,
						feedbackMs,
						presentedMs: Math.round(performance.now() - launchStarted),
						sourceId: source.id,
						sourceRetained: api.getPanel(source.id) === source,
						existingPaneIds: [...existingPanes.keys()],
						expectedCwd: path,
						panels: api.panels.map((panel) => ({
							id: panel.id,
							component: panel.api.component,
							cwd: panel.params?.cwd,
						})),
					});
					const addedPanes = api.panels.filter(
						(panel) => !existingPanes.has(panel.id),
					);
					if (
						[...existingPanes].some(
							([id, panel]) => api.getPanel(id) !== panel,
						) ||
						addedPanes.length !== 1 ||
						addedPanes[0].id !== selector.id ||
						addedPanes[0].api.component !== "terminal" ||
						addedPanes[0].params?.cwd !== path
					)
						throw new Error(
							"Quick-start QA repeated launcher click changed the source or created extra panes",
						);
					launcher = {
						feedbackMs,
						presentedMs: Math.round(performance.now() - launchStarted),
					};
					useStore.setState({ accounts: [], activeAccounts: {} });
					button.click();
					await wait(
						"corrected launch did not settle",
						() => settled.current === 4,
						45_000,
					);
					const created = useStore.getState().agents;
					if (created.length !== 1 || !agentPane(created[0].id))
						throw new Error("Corrected launch did not create exactly one pane");
					recovery = {
						retry: true,
						menu: true,
						terminal: true,
						correctedLaunch: true,
					};
				}
				const created = useStore.getState().agents;
				const nativePresentation =
					created.length === 1
						? await presentation.ready(created[0].id)
						: undefined;
				qaLog("repository-quick-start", {
					proof,
					nativePresentation,
					firstFailure,
					feedbackText: feedbackText.map((text) => text.slice(0, 1024)),
					recovery,
					launcher,
					feedbackVisible,
					result: invalidProfile
						? settled.current > 0 && feedbackVisible && !button.disabled
							? "passed"
							: "failed"
						: settled.current === 0
							? "pending"
							: error
								? "error"
								: agents.some((agent) => agentPane(agent.id))
									? "passed"
									: "pane_missing",
					buttonConnected: button.isConnected,
					busy: button.disabled,
					error,
					panes: useStore.getState().agents.map((agent) => ({
						provider: agent.provider,
						worktreePath: agent.worktreePath,
						mounted: Boolean(agentPane(agent.id)),
					})),
					pending: [...pending],
					events,
				});
			} finally {
				presentation.dispose();
				acknowledge?.();
				window.fetch = original;
			}
		};
		void run().catch((error) => {
			if (!stopped)
				qaLog("repository-quick-start", {
					proof,
					result: "failed",
					error: String(error),
				});
		});
		return () => {
			stopped = true;
		};
	}, []);
	if (!fixture) return null;
	const target = { label: "Quick-start QA", path: fixture.path };
	return (
		<div style={{ width: 1000, height: 700 }}>
			<SpacesRepositoryActions
				target={target}
				onAddTerminal={(target) =>
					handlers.onAddRepositoryTerminal(fixture.spaceId, target)
				}
				onAddAgent={(target, provider) =>
					handlers
						.onAddRepositoryAgent(fixture.spaceId, target, provider)
						.finally(() => {
							settled.current += 1;
						})
				}
				onAddAgentWithOptions={(target) =>
					handlers.onAddRepositoryAgentWithOptions(fixture.spaceId, target)
				}
			/>
			<Workspace desktopId={fixture.spaceId} active />
			<Toaster />
		</div>
	);
}
