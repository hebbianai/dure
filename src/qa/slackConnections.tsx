import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { SlackConnectionsPanel } from "@/components/plugins/SlackConnectionsPanel";
import { setLang, t } from "@/lib/i18n";
import { homeDir } from "@/lib/ipc";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import { qaLog } from "@/lib/qa/qaLog";
import { durableAppStorage, useStore } from "@/store";

const proof = new URLSearchParams(location.search).get("qaSlackConnections");
const checkpointKey = `qa-slack-connections:${proof}`;

function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

function button(label: string) {
	return [...document.querySelectorAll("button")].find(
		(element) => element.textContent?.trim() === label && !element.disabled,
	);
}

function field(label: string): HTMLInputElement {
	const element = [...document.querySelectorAll("label")].find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	const input = element && document.getElementById(element.htmlFor);
	requireFact(input instanceof HTMLInputElement, `Missing input: ${label}`);
	return input;
}

function fill(label: string, value: string) {
	const input = field(label);
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	requireFact(setter, "Native input setter is unavailable");
	flushSync(() => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** Real native settings and backend; the runner replaces only Slack's network
 * transport. No channel route, provider task or foreground input is created. */
export function SlackConnectionsQaRoot() {
	useEffect(() => {
		if (!proof) return;
		let disposed = false;
		async function wait<T>(label: string, observe: () => T | Promise<T>) {
			const deadline = performance.now() + 30_000;
			while (!disposed && performance.now() < deadline) {
				const value = await observe();
				if (value) return value;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			}
			throw new Error(`Did not observe ${label}`);
		}
		async function click(label: string) {
			(await wait(label, () => button(label))).click();
		}
		const run = async () => {
			const home = await homeDir();
			requireFact(
				home.includes("/dure-slack-connections.") && home.endsWith("/home"),
				"Slack settings QA escaped its disposable HOME",
			);
			await useStore.persist.rehydrate();
			setLang("en");
			const saved = sessionStorage.getItem(checkpointKey);
			if (!saved) {
				useStore.setState((state) => ({
					uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
				}));
				await durableAppStorage.flush();
			} else {
				requireFact(
					useStore.getState().uiPrefs.interfaceMode === "pro",
					"Reload lost the selected Pro interface",
				);
			}
			const api = createSlackConnectorClient();
			const initial = await api.list();
			const connection = async (state: string) => {
				const snapshot = await api.list(initial.authority);
				const entry = snapshot.connections.find(
					(candidate) => candidate.config.teamId === "T1",
				);
				requireFact(
					entry?.connection !== "failed",
					`Native connector failed: ${entry?.failure}`,
				);
				return entry?.connection === state ? entry : undefined;
			};
			const rendered = (state: "connected" | "stopped") =>
				wait(`rendered ${state}`, () =>
					document.body.textContent?.includes(
						t(`plugins.slack.state.${state}`),
					),
				);
			if (!saved) {
				requireFact(initial.connections.length === 0, "QA home was not empty");
				await click(t("plugins.slack.addWorkspace"));
				await wait("connection editor", () =>
					button(t("plugins.slack.saveConnect")),
				);
				fill(t("plugins.slack.workspace"), "https://app.slack.com/client/T1");
				fill(t("plugins.slack.appToken"), "fixture-app");
				fill(t("plugins.slack.botToken"), "fixture-bot");
				await click(t("plugins.slack.saveConnect"));
				const first = await wait("native connection", () =>
					connection("connected"),
				);
				await rendered("connected");
				requireFact(
					first.credentialsConfigured && first.generation,
					"No saved credentials or generation",
				);
				requireFact(
					first.config.channels.length === 0,
					"QA must not route channel events",
				);
				requireFact(
					field(t("plugins.slack.appToken")).value === "" &&
						field(t("plugins.slack.botToken")).value === "",
					"Saved token fields were not cleared",
				);
				sessionStorage.setItem(
					checkpointKey,
					JSON.stringify({ generation: first.generation }),
				);
				location.reload();
				return;
			}
			const checkpoint: { generation: string } = JSON.parse(saved);
			const restored = await wait("connection after reload", () =>
				connection("connected"),
			);
			requireFact(
				restored.generation === checkpoint.generation,
				"WebView reload replaced the connector",
			);
			await rendered("connected");
			await click(t("plugins.slack.edit"));
			await wait("restored editor", () =>
				button(t("plugins.slack.saveConnect")),
			);
			requireFact(
				field(t("plugins.slack.workspace")).value === "T1",
				"Workspace link was not normalized",
			);
			requireFact(
				field(t("plugins.slack.appToken")).value === "" &&
					field(t("plugins.slack.botToken")).value === "",
				"Stored credentials leaked back into the form",
			);
			await click(t("plugins.slack.disconnect"));
			await wait("disconnect before reconnect", () => connection("stopped"));
			await rendered("stopped");
			await click(t("plugins.slack.saveConnect"));
			const reconnected = await wait("blank-token reconnect", async () => {
				const entry = await connection("connected");
				return entry?.generation !== checkpoint.generation ? entry : undefined;
			});
			requireFact(
				reconnected.credentialsConfigured,
				"Blank fields removed stored credentials",
			);
			await rendered("connected");
			await click(t("plugins.slack.disconnect"));
			const stopped = await wait("disconnect", () => connection("stopped"));
			requireFact(
				!stopped.enabled && stopped.credentialsConfigured,
				"Disconnect lost saved settings",
			);
			await rendered("stopped");
			const window = getCurrentWindow();
			requireFact(await window.isVisible(), "Native QA window is not visible");
			requireFact(!(await window.isFocused()), "Native QA stole OS focus");
			qaLog("slack-connections", {
				proof,
				result: "passed",
				realWebview: true,
				realBackend: true,
				realSlack: false,
				realProvider: false,
				channels: 0,
				generation: checkpoint.generation,
				reconnectedGeneration: reconnected.generation,
				reloadPreserved: true,
				credentialsReused: true,
				disconnected: true,
				visible: true,
				focused: false,
			});
		};
		void run().catch((error) => {
			if (!disposed)
				qaLog("slack-connections", {
					proof,
					result: "failed",
					error: String(error),
				});
		});
		return () => {
			disposed = true;
		};
	}, []);
	return (
		<main className="max-w-xl">
			<SlackConnectionsPanel />
		</main>
	);
}
