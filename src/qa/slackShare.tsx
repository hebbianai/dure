import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { AgentSlackShare } from "@/components/agents/chat/AgentSlackShare";
import { SlackTeamConnections } from "@/components/plugins/SlackTeamConnections";
import type { AgentChatDraftIdentity } from "@/lib/agents/chat/agentChatDraftTypes";
import { acquireAgentChatSession } from "@/lib/agents/chat/agentChatSessionRuntime";
import type { AgentInteractionBindingV1 } from "@/lib/agents/chat/agentConversationContract";
import { setLang, t } from "@/lib/i18n";
import { homeDir, readFile, writeFile } from "@/lib/ipc";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { createDureAgentRunTransport } from "@/lib/ipc/dureAgentRun";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { createDureBackendRequester } from "@/lib/ipc/dureBackend";
import { createSlackConnectorClient } from "@/lib/ipc/slackConnector";
import { asRecord } from "@/lib/payloadGuards";
import { qaLog } from "@/lib/qa/qaLog";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { durableAppStorage, useStore } from "@/store";
import { exerciseAccountRecovery } from "./accountRecovery";
import { exerciseAccountQueue } from "./slackShareAccountQueue";
import {
	exerciseLiveSlackShare,
	type LiveSlackConfiguration,
} from "./slackShareLive";
import { SlackTagQa } from "./slackTag";

const proof = new URLSearchParams(location.search).get("qaSlackShare");
const live = new URLSearchParams(location.search).get("slackLive") === "1";
const checkpointKey = `qa-slack-share:${proof}`;
function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
interface Checkpoint {
	identity: AgentChatDraftIdentity;
	binding: AgentInteractionBindingV1;
	generation: string;
}
interface Post {
	method: string;
	ts: string;
	body: { text: string; thread_ts?: string };
}

/** Actual native UI, installed connector and Codex. The runner chooses a
 * recording Slack fixture or an explicitly configured real workspace. */
export function SlackShareQaRoot() {
	const [teamView, setTeamView] = useState(false);
	const [tagView, setTagView] = useState(false);
	const [identity, setIdentity] = useState<AgentChatDraftIdentity>();
	useEffect(() => {
		if (!proof) return;
		let disposed = false;
		async function wait<T>(label: string, observe: () => T | Promise<T>) {
			const deadline = performance.now() + (live ? 600_000 : 120_000);
			while (!disposed && performance.now() < deadline) {
				const value = await observe();
				if (value) return value;
				await new Promise<void>((resolve) => setTimeout(resolve, 100));
			}
			throw new Error(`Did not observe ${label}`);
		}
		const run = async () => {
			const home = (await homeDir()).replace(/\/$/, "");
			requireFact(
				home.includes("/dure-slack-share.") && home.endsWith("/home"),
				"Native sharing QA escaped its disposable HOME",
			);
			const configuration: LiveSlackConfiguration = live
				? JSON.parse((await readFile(`${home}/slack-live.json`)).content)
				: {
						teamId: "T1",
						channelId: "C1",
						appToken: "fixture-app",
						botToken: "fixture-bot",
					};
			await useStore.persist.rehydrate();
			setLang("en");
			useStore.setState((state) => ({
				uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
			}));
			await durableAppStorage.flush();
			const slack = createSlackConnectorClient();
			let initial = await slack.list();
			const conversation = createDureAgentConversationClient({
				profileId: initial.authority.profileId,
			});
			const connection = async () => {
				const current = (await slack.list(initial.authority)).connections.find(
					(entry) => entry.config.teamId === configuration.teamId,
				);
				requireFact(
					current?.connection !== "failed",
					`Connector failed: ${current?.failure}`,
				);
				return current?.connection === "connected" ? current : undefined;
			};
			const completed = (binding: AgentInteractionBindingV1, marker: string) =>
				wait(marker, async () => {
					const { read } = await conversation.read({
						schemaVersion: 1,
						interactionSessionId: binding.interactionSessionId,
						direction: "tail",
						cursor: null,
						limit: 100,
					});
					requireFact(read.type === "page", "Conversation reset unexpectedly");
					requireFact(
						live || read.page.pendingRequests.length === 0,
						"Unexpected provider permission or question",
					);
					requireFact(
						!read.page.rows.some(
							({ item }) =>
								item.body.type === "lifecycle" &&
								["turn_failed", "turn_canceled"].includes(item.body.state),
						),
						"Actual provider turn failed",
					);
					return !read.page.activeTurn &&
						read.page.rows.some(
							({ item }) =>
								item.body.type === "message" &&
								item.body.role === "assistant" &&
								item.body.markdown.includes(marker),
						)
						? read.page
						: undefined;
				});
			const saved = sessionStorage.getItem(checkpointKey);
			let checkpoint: Checkpoint;
			if (!saved) {
				requireFact(
					initial.connections.length === 0,
					"QA connection home was not empty",
				);
				const request = createDureBackendRequester({
					invalidResponseCode: "qa_invalid",
					invalidResponseMessage: "Invalid QA response",
					backendChangedCode: "qa_changed",
					backendChangedMessage: "QA backend changed",
					requestFailedCode: "qa_failed",
					requestFailedMessage: "QA request failed",
				});
				await request(
					"projects.register",
					{
						schemaVersion: 1,
						projectId: "native-slack-share",
						displayName: "Native Slack share QA",
						root: `${home}/project`,
					},
					{ kind: "exact", authority: initial.authority },
				);
				qaLog("slack-share-progress", { proof, phase: "launching-provider" });
				const agent = await createDureAgentRunTransport().run(
					{
						projectId: "native-slack-share",
						providerId: "codex",
						agentName: "native-slack-share",
						worktree: { kind: "project_root" },
						idempotencyKey: `native-share-${proof}`,
						prompt: `Reply exactly QA_PRIVATE_${proof}. Do not use tools.`,
					},
					initial.authority,
				);
				requireFact(
					agent.interactionProfile === "structured_protocol",
					"QA needs the actual structured conversation",
				);
				const { binding } = await conversation.inspect(agent.agentId);
				requireFact(binding, "Spawn did not create a conversation binding");
				const privatePage = await completed(binding, `QA_PRIVATE_${proof}`);
				qaLog("slack-share-progress", {
					proof,
					phase: "private-turn-complete",
					agentId: agent.agentId,
				});
				await slack.connect(
					{
						config: {
							schemaVersion: 1,
							teamId: configuration.teamId,
							channels: [
								{
									channelId: configuration.channelId,
									projectId: "native-slack-share",
									providerId: "codex",
								},
							],
						},
						appToken: configuration.appToken,
						botToken: configuration.botToken,
					},
					initial.authority,
				);
				const connected = await wait("connected connector", connection);
				requireFact(connected.generation, "Connector has no generation");
				checkpoint = {
					identity: {
						agentId: agent.agentId,
						interactionSessionId: binding.interactionSessionId,
						backendProfileId: initial.authority.profileId,
					},
					binding: privatePage.binding,
					generation: connected.generation,
				};
			} else {
				checkpoint = JSON.parse(saved);
				const connected = await wait("connector after reload", connection);
				requireFact(
					connected.generation === checkpoint.generation,
					"WebView reload replaced the connector",
				);
				const { binding } = await conversation.inspect(
					checkpoint.identity.agentId,
				);
				requireFact(
					binding?.interactionSessionId ===
						checkpoint.binding.interactionSessionId &&
						binding.providerConversationRef ===
							checkpoint.binding.providerConversationRef,
					"Reload changed the shared conversation",
				);
			}
			const queuedMarker = `QA_QUEUED_${proof}`;
			const queuedInput = `Reply exactly ${queuedMarker}. Do not use tools.`;
			if (saved && !live) {
				// This new WebView has not acquired any chat-session lease.
				const queuedPage = await completed(checkpoint.binding, queuedMarker);
				requireFact(
					queuedPage.rows.filter(
						({ item }) =>
							item.body.type === "message" &&
							item.body.role === "user" &&
							item.body.markdown === queuedInput,
					).length === 1,
					"Reload duplicated or lost accepted queued input",
				);
				requireFact(
					queuedPage.queuedInputs?.inputs.length === 0,
					"Completed input remained queued",
				);
				qaLog("slack-share-progress", {
					proof,
					phase: "queue-completed-without-view-after-reload",
				});
			}
			flushSync(() => setIdentity(checkpoint.identity));
			const opener = await wait("share control", () =>
				document.querySelector<HTMLButtonElement>(
					`button[aria-label="${t("plugins.slack.share")}"]`,
				),
			);
			opener.click();
			const picker = await wait("channel picker", () =>
				document.querySelector<HTMLButtonElement>('[role="combobox"]'),
			);
			picker.dispatchEvent(
				new KeyboardEvent("keydown", { key: " ", bubbles: true }),
			);
			(
				await wait("configured channel", () =>
					document.querySelector<HTMLElement>(
						`[role="option"][data-value="${configuration.teamId}:${configuration.channelId}"]`,
					),
				)
			).click();
			const submit = await wait("share submit", () =>
				[
					...document.querySelectorAll<HTMLButtonElement>(
						'[role="dialog"] button',
					),
				].find(
					(button) =>
						button.textContent?.trim() === t("plugins.slack.share") &&
						!button.disabled,
				),
			);
			submit.click();
			await wait("native share result", () => {
				const error = document.querySelector('[role="alert"]');
				requireFact(!error, `Sharing failed: ${error?.textContent}`);
				return document
					.querySelector('[role="status"]')
					?.textContent?.includes(t("plugins.slack.shared"));
			});
			qaLog("slack-share-progress", {
				proof,
				phase: saved ? "reshared-after-reload" : "shared",
			});
			if (!saved) {
				if (!live) {
					const lease = acquireAgentChatSession(checkpoint.identity);
					try {
						await wait(
							"queue controller ready",
							() => lease.controller.getSnapshot().phase === "ready",
						);
						await lease.controller.queueMessage(
							"Write the integers from 1 through 400 in order, separated by spaces, with no omissions or other text. Do not use tools.",
						);
						await lease.controller.queueMessage(queuedInput);
						requireFact(
							lease.controller
								.getSnapshot()
								.queuedMessages.some((input) => input.preview === queuedInput),
							"No pending queue remained before the native reload; reproduction is incomplete",
						);
					} finally {
						lease.release();
					}
					qaLog("slack-share-progress", {
						proof,
						phase: "queue-admitted-before-reload",
					});
				}
				sessionStorage.setItem(checkpointKey, JSON.stringify(checkpoint));
				location.reload();
				return;
			}
			const finish = async (result: Record<string, unknown>) => {
				await slack.disconnect(configuration.teamId, initial.authority);
				await createDureAgentRuntimeClient({
					profileId: initial.authority.profileId,
				}).stop(checkpoint.identity.agentId, initial.authority);
				const window = getCurrentWindow();
				requireFact(await window.isVisible(), "Native window was not visible");
				requireFact(!(await window.isFocused()), "Native QA stole OS focus");
				qaLog("slack-share", {
					proof,
					result: "passed",
					realWebview: true,
					realBackend: true,
					realProvider: true,
					realSlack: live,
					visible: true,
					focused: false,
					privateHistoryPreserved: true,
					reloadPreserved: true,
					noViewQueueAfterReload: !live,
					providerStopped: true,
					duplicateThreads: 0,
					generation: checkpoint.generation,
					agentId: checkpoint.identity.agentId,
					...result,
				});
			};
			if (live) {
				const shared = await slack.share(
					{
						requestId: `live-observe-${proof}`,
						teamId: configuration.teamId,
						channelId: configuration.channelId,
						agentId: checkpoint.identity.agentId,
						interactionSessionId: checkpoint.binding.interactionSessionId,
					},
					initial.authority,
				);
				await finish(
					await exerciseLiveSlackShare({
						proof,
						home,
						binding: checkpoint.binding,
						conversation,
						completed,
						wait,
						threadTs: shared.threadTs,
					}),
				);
				return;
			}
			const marker = `QA_PUBLIC_${proof}`;
			const { binding } = await conversation.inspect(
				checkpoint.identity.agentId,
			);
			requireFact(binding, "Shared conversation binding disappeared");

			// A fresh settings view discovers the task from the shared backend,
			// then its production composer directs the existing conversation.
			flushSync(() => setTeamView(true));
			const taskButton = await wait("shared task entry", () =>
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) =>
						button.textContent?.trim() === t("plugins.slack.teamTasks"),
				),
			);
			taskButton.click();
			(
				await wait("shared project task", () =>
					[
						...document.querySelectorAll<HTMLButtonElement>(
							'[role="dialog"] button',
						),
					].find((button) =>
						button.textContent?.includes(checkpoint.identity.agentId),
					),
				)
			).click();
			const composer = await wait("shared conversation composer", () =>
				document.querySelector<HTMLTextAreaElement>(
					`textarea[aria-label="${t("agents.chat.composerLabel")}"]`,
				),
			);
			requireFact(!composer.disabled, "Shared composer is disabled");
			const observed = await conversation.read({
				schemaVersion: 1,
				interactionSessionId: binding.interactionSessionId,
				direction: "tail",
				cursor: null,
				limit: 100,
			});
			requireFact(
				observed.read.type === "page",
				"Continuation needs an observed page",
			);
			const retained = {
				expectedCursor: observed.read.page.finalCursor,
				intent: {
					schemaVersion: 1 as const,
					interactionSessionId: binding.interactionSessionId,
					runtime: binding.runtime,
					turnId: `retained-${proof}`,
					clientMessageId: `retained-${proof}`,
					input: "Reply OBSOLETE. Do not use tools.",
					requestedAtMs: Date.now(),
				},
			};
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			requireFact(setter, "Native textarea setter is unavailable");
			flushSync(() => {
				setter.call(composer, `Reply exactly ${marker}. Do not use tools.`);
				composer.dispatchEvent(new Event("input", { bubbles: true }));
			});
			(
				await wait("shared composer submit", () => {
					const submit = composer
						.closest("form")
						?.querySelector<HTMLButtonElement>('button[type="submit"]');
					return submit && !submit.disabled ? submit : undefined;
				})
			).click();
			const page = await completed(binding, marker);
			requireFact(
				(await conversation.continueTurn(retained, observed.routeAuthority)) ===
					null,
				"An obsolete automatic request was sent after the teammate completed",
			);
			const afterContinuation = await conversation.read({
				schemaVersion: 1,
				interactionSessionId: binding.interactionSessionId,
				direction: "tail",
				cursor: null,
				limit: 100,
			});
			requireFact(
				afterContinuation.read.type === "page" &&
					!afterContinuation.read.page.activeTurn &&
					!afterContinuation.read.page.rows.some(
						({ item }) =>
							item.clientMessageId === retained.intent.clientMessageId,
					),
				"Rejected continuation changed the shared conversation",
			);
			qaLog("slack-share-progress", {
				proof,
				phase: "obsolete-continuation-not-sent",
			});
			const reply = page.rows.find(
				({ item }) =>
					item.body.type === "message" &&
					item.body.role === "assistant" &&
					item.body.markdown.includes(marker),
			)?.item.body;
			requireFact(reply?.type === "message", "The provider reply disappeared");
			const assistantReply = reply.markdown.trim();
			const posts = await wait(
				"actual connector's outbound update",
				async () => {
					const source = (await readFile(`${home}/slack-share-posts.jsonl`))
						.content;
					requireFact(
						!source.includes(`QA_PRIVATE_${proof}`),
						"Earlier private messages leaked to Slack",
					);
					const entries: Post[] = source
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line));
					return entries.some(
						(post) => post.body.text.trim() === assistantReply,
					)
						? entries
						: undefined;
				},
			);
			const parents = posts.filter(
				(post) => post.method === "chat.postMessage" && !post.body.thread_ts,
			);
			requireFact(
				parents.length === 1,
				"Sharing after reload created a duplicate Slack thread",
			);
			requireFact(
				posts
					.filter((post) => post.body.text.includes(marker))
					.every(
						(post) =>
							post.body.thread_ts === parents[0].ts ||
							post.method === "chat.update",
					),
				"The public reply escaped its shared thread",
			);
			flushSync(() => setTagView(true));
			const tagTask = await wait("Dure Tag sidebar task", () =>
				document.querySelector<HTMLButtonElement>(
					`[data-tag-agent-id="${checkpoint.identity.agentId}"]`,
				),
			);
			tagTask.click();
			await wait(
				"Dure Tag sidebar conversation",
				() =>
					document.querySelector("[data-qa-tag] textarea") &&
					document
						.querySelector("[data-qa-tag]")
						?.textContent?.includes(marker),
			);
			requireFact(
				getDockview(useStore.getState().activeSpaceId)?.panels.length === 0,
				"Opening a Tag conversation added a pane to the ordinary Space",
			);
			const back = document.querySelector<HTMLButtonElement>(
				`[data-tag-conversation] button[aria-label="${t("common.back")}"]`,
			);
			requireFact(back, "Tag conversation has no return to its task list");
			back.click();
			const reopenedTask = await wait("Dure Tag task list", () =>
				document.querySelector<HTMLButtonElement>(
					`[data-tag-agent-id="${checkpoint.identity.agentId}"]`,
				),
			);
			reopenedTask.click();
			await wait("Dure Tag reopened conversation", () =>
				document.querySelector("[data-tag-conversation] textarea"),
			);
			requireFact(
				document.querySelectorAll("[data-qa-tag] textarea").length === 1 &&
					getDockview(useStore.getState().activeSpaceId)?.panels.length === 0,
				"Selecting a Tag task duplicated or opened a Space pane",
			);
			const restartInput = `Reply exactly QA_RESTART_WEBVIEW_${proof}. Do not use tools.`;
			const secondClientInput = `Reply exactly QA_RESTART_CLI_${proof}. Do not use tools.`;
			const restartLease = acquireAgentChatSession(checkpoint.identity);
			let queuedMessageId: string;
			try {
				await wait(
					"restart queue controller ready",
					() => restartLease.controller.getSnapshot().phase === "ready",
				);
				await restartLease.controller.send(
					"Run python3 queue-barrier.py and wait for it to finish. Then reply exactly QA_ACTIVE_DONE. Do not run other tools or change files.",
				);
				await wait("real provider tool is waiting", async () => {
					const observed = await conversation.read({
						schemaVersion: 1,
						interactionSessionId: checkpoint.binding.interactionSessionId,
						direction: "tail",
						cursor: null,
						limit: 1,
					});
					requireFact(
						observed.read.type === "page",
						"The barrier turn has no conversation",
					);
					for (const pending of observed.read.page.pendingRequests) {
						const command = asRecord(asRecord(pending.request.payload)?.input);
						requireFact(
							pending.request.kind === "permission" &&
								command?.command === "/bin/zsh -lc 'python3 queue-barrier.py'",
							"The fixture only authorizes its requested barrier command",
						);
						await conversation.answerPending(
							{
								schemaVersion: 1,
								interactionSessionId: pending.interactionSessionId,
								runtime: pending.runtime,
								requestId: pending.request.requestId,
								clientMessageId: pending.request.clientMessageId,
								idempotencyKey: `barrier-${proof}-${pending.request.requestId}`,
								answer: { decision: "allow" },
								requestedAtMs: pending.request.createdAtMs,
							},
							observed.routeAuthority,
						);
					}
					try {
						return (
							(await readFile(`${home}/project/queue-active`)).content ===
							"waiting"
						);
					} catch {
						return false;
					}
				});
				await restartLease.controller.queueMessage(restartInput);
				const queued = restartLease.controller
					.getSnapshot()
					.queuedMessages.find((input) => input.preview === restartInput);
				requireFact(
					queued,
					"No accepted input was pending before backend replacement",
				);
				queuedMessageId = queued.clientMessageId;
			} finally {
				restartLease.release();
			}
			const draft = `QA_UNSENT_${proof}`;
			const tagComposer = document.querySelector<HTMLTextAreaElement>(
				"[data-tag-conversation] textarea",
			);
			requireFact(tagComposer, "Tag composer disappeared");
			const setDraft = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			requireFact(setDraft, "Native textarea setter is unavailable");
			flushSync(() => {
				setDraft.call(tagComposer, draft);
				tagComposer.dispatchEvent(new Event("input", { bubbles: true }));
			});
			qaLog("slack-tag-reconnect", {
				proof,
				generation: initial.authority.backend.generation,
				interactionSessionId: checkpoint.binding.interactionSessionId,
				queuedMessageId,
				secondClientInput,
			});
			initial = await wait("replacement backend", async () => {
				try {
					const next = await slack.list();
					return next.authority.backend.generation !==
						initial.authority.backend.generation
						? next
						: undefined;
				} catch {
					return undefined;
				}
			});
			await wait(
				"Tag draft and conversation recovered without reopening",
				() => {
					const composer = document.querySelector<HTMLTextAreaElement>(
						"[data-tag-conversation] textarea",
					);
					return (
						composer &&
						composer !== tagComposer &&
						composer.value === draft &&
						!composer.disabled &&
						document
							.querySelector("[data-tag-conversation]")
							?.textContent?.includes(marker)
					);
				},
			);
			requireFact(
				getDockview(useStore.getState().activeSpaceId)?.panels.length === 0,
				"Backend recovery created a Space pane",
			);
			const unsent = (await readFile(`${home}/slack-share-posts.jsonl`))
				.content;
			requireFact(
				!unsent.includes(draft),
				"Backend recovery sent the draft to Slack",
			);
			const recovered = await conversation.read({
				schemaVersion: 1,
				interactionSessionId: checkpoint.binding.interactionSessionId,
				direction: "tail",
				cursor: null,
				limit: 100,
			});
			requireFact(
				recovered.read.type === "page",
				"Recovered queue has no conversation",
			);
			requireFact(
				recovered.read.page.queuedInputs?.inputs[0]?.clientMessageId ===
					queuedMessageId &&
					recovered.read.page.queuedInputs.inputs[1]?.preview ===
						secondClientInput,
				"Backend replacement changed pending input identity or client order",
			);
			qaLog("slack-queue-recovered", { proof, queuedMessageId });
			const executed = await completed(
				recovered.read.page.binding,
				`QA_RESTART_CLI_${proof}`,
			);
			const delivered = executed.rows
				.filter(
					({ item }) =>
						item.body.type === "message" &&
						item.body.role === "user" &&
						(item.body.markdown === restartInput ||
							item.body.markdown === secondClientInput),
				)
				.map(({ item }) =>
					item.body.type === "message" ? item.body.markdown : "",
				);
			requireFact(
				JSON.stringify(delivered) ===
					JSON.stringify([restartInput, secondClientInput]) &&
					executed.queuedInputs?.inputs.length === 0,
				"Two clients' pending inputs did not execute once in admission order",
			);
			qaLog("slack-share-progress", {
				proof,
				phase: "tag-sidebar-opened-existing-conversation",
			});
			flushSync(() => setTagView(false));
			const accountQueue = await exerciseAccountQueue({
				home,
				proof: proof as string,
				binding: executed.binding,
				authority: initial.authority,
				wait,
			});
			const accountRecovery = await exerciseAccountRecovery({
				home, proof: proof as string, binding: executed.binding,
				authority: initial.authority, wait,
			});
			const native = await createDureAgentRuntimeClient({
				profileId: initial.authority.profileId,
			}).transition({
				agentId: checkpoint.identity.agentId,
				targetInteractionProfile: "native_cli",
				routeAuthority: initial.authority,
			});
			requireFact(
				native.interactionProfile === "native_cli",
				"Expected terminal runtime",
			);
			const nativeRequest = createDureBackendRequester({
				invalidResponseCode: "qa_invalid",
				invalidResponseMessage: "Invalid native response",
				backendChangedCode: "qa_changed",
				backendChangedMessage: "QA backend changed",
				requestFailedCode: "qa_failed",
				requestFailedMessage: "QA request failed",
			});
			const nativeRead = () =>
				nativeRequest(
					"agent_runtime.native.read",
					{
						schemaVersion: 1,
						agentId: checkpoint.identity.agentId,
						expectedSelectionRevision: native.selectionRevision,
						expectedTerminalEpoch: native.stopFence.terminalEpoch,
					},
					{ kind: "exact", authority: native.routeAuthority },
				);
			await wait("native provider waiting for input", async () => {
				const { result } = await nativeRead();
				return result.waiting === true;
			});
			const nativeMarker = `QA_NATIVE_${proof}`;
			await writeFile(
				`${home}/slack-share-inbound.json`,
				JSON.stringify({
					type: "events_api",
					envelope_id: `native-${proof}`,
					payload: {
						type: "event_callback",
						team_id: "T1",
						event: {
							type: "message",
							user: "U2",
							channel: "C1",
							thread_ts: parents[0].ts,
							ts: "201.000001",
							text: `Do not use tools. Reply with only the token on the next line, without quotes or punctuation:\n${nativeMarker}`,
						},
					},
				}),
			);
			const nativeAssistantReply = await wait(
				"native provider final response",
				async () => {
					const { result } = await nativeRead();
					return result.waiting === true &&
						typeof result.finalResponse === "string" &&
						result.finalResponse.includes(nativeMarker)
						? result.finalResponse
						: undefined;
				},
			);
			await wait("terminal reply in the same Slack thread", async () => {
				const source = (await readFile(`${home}/slack-share-posts.jsonl`))
					.content;
				requireFact(
					!source.includes(`QA_PRIVATE_${proof}`),
					"Native bridge leaked private history",
				);
				return source
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Post)
					.some(
						(post) =>
							post.body.thread_ts === parents[0].ts &&
							post.body.text.trim() === nativeAssistantReply.trim(),
					);
			});
			await finish({
				nativeThreadReply: true,
				obsoleteContinuationNotSent: true,
				nativeAssistantReply,
				tagSidebarConversation: true,
				tagGenerationRecovered: true,
				binding: page.binding,
				threadTs: parents[0].ts,
				assistantReply,
				outboundCalls: posts.length,
				sharedTaskComposer: true,
				queuedAcrossBackendReplacement: true,
				independentQueueClients: true,
				...accountQueue,
				...accountRecovery,
			});
		};
		void run().catch((error) => {
			if (!disposed)
				qaLog("slack-share", { proof, result: "failed", error: String(error) });
		});
		return () => {
			disposed = true;
		};
	}, []);
	return (
		<main className="p-4">
			{tagView ? (
				<SlackTagQa />
			) : teamView ? (
				<SlackTeamConnections />
			) : (
				identity && <AgentSlackShare identity={identity} />
			)}
		</main>
	);
}
