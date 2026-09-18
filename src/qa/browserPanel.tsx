import { type DockviewApi, DockviewReact } from "dockview-react";
import { createRoot } from "react-dom/client";
import { BrowserPanel } from "@/components/panels/BrowserPanel";
import {
	BrowserPaneSession,
	type BrowserPaneView,
} from "@/lib/browser/browserPaneSession";
import { parseBrowserResource } from "@/lib/browser/browserResourceContract";
import { t } from "@/lib/i18n";
import {
	probeSelectedDureBackend,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";
import { startRegistrySync } from "@/lib/persistence/registry";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

interface Configuration {
	presentation?: boolean;
	revision: number;
	action: string;
	resource?: unknown;
	pageId?: string;
	url?: string;
	text?: string;
	color?: number[];
	point?: { x: number; y: number };
	label?: string;
	pending?: boolean;
	controlled?: boolean;
	profileId?: string;
	profileName?: string;
	nativeUserAgent?: boolean;
	focusAddressBeforeObservation?: boolean;
}

/** Native product-panel probe. Only instructions/reports use the QA channel;
 * all browser observation, input and control use the real Tauri backend route. */
export async function runBrowserPanelProbe(): Promise<void> {
	if (!import.meta.env.DEV) return;
	const channel = import.meta.env.VITE_DURE_BROWSER_QA_CHANNEL;
	const token = import.meta.env.VITE_DURE_BROWSER_QA_TOKEN;
	if (!channel || !token)
		throw new Error("Browser panel QA channel is missing");
	const element = document.createElement("section");
	element.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
	document.body.append(element);
	let api: DockviewApi | undefined;
	let root: ReturnType<typeof createRoot> | undefined;
	let spaceId: string | undefined;
	let stopRegistry: (() => void) | undefined;
	let revision = 0;
	let stopped = false;
	let currentAction = "";
	let refreshTimings: { start: number; end: number }[] | undefined;
	let interaction: unknown;
	let focusAddressBeforeObservation = false;
	let observedFrame: BrowserPaneView["frame"];
	let observedSession: BrowserPaneSession | undefined;
	let resumeFrames: (() => void) | undefined;
	let compositionReceiver: HTMLTextAreaElement | undefined;
	let stopNativeIme: (() => void) | undefined;
	let nativeIme:
		| {
				overflow: boolean;
				page: BrowserPaneView["page"];
				controller: NonNullable<BrowserPaneView["control"]>["controller"];
				events: {
					type: string;
					trusted: boolean;
					connected: boolean;
					data?: string | null;
					code?: string;
					isComposing?: boolean;
				}[];
		  }
		| undefined;
	const selectionTrace: unknown[] = [];
	const traced = new WeakSet<BrowserPaneSession>();
	const trace = (event: unknown) => {
		selectionTrace.push({ revision, action: currentAction, event });
		if (selectionTrace.length > 512) selectionTrace.shift();
	};
	const originalRefresh = BrowserPaneSession.prototype.refresh;
	const originalSelect = BrowserPaneSession.prototype.selectPage;
	BrowserPaneSession.prototype.refresh = function () {
		if (focusAddressBeforeObservation) {
			const address = element.querySelector<HTMLInputElement>(
				`input[aria-label="${t("panels.browser.address")}"]`,
			);
			if (!address) throw new Error("Address field is not mounted");
			address.focus();
			if (document.activeElement !== address)
				throw new Error("Address field did not receive DOM focus");
			focusAddressBeforeObservation = false;
		}
		observedSession = this;
		if (!traced.has(this)) {
			traced.add(this);
			this.subscribe(() => {
				const view = this.read();
				observedFrame = view.frame;
				trace({
					kind: "view",
					selectedPageId: view.selectedPageId,
					followingCurrent: view.followingCurrent,
					page: view.page,
					control: view.control,
					observation: view.observation,
					error: view.error?.message,
				});
			});
		}
		const timings = refreshTimings;
		const start = performance.now();
		const result = originalRefresh.call(this);
		if (timings)
			void result.then(() => timings.push({ start, end: performance.now() }));
		return result;
	};
	BrowserPaneSession.prototype.selectPage = function (pageId) {
		trace({ kind: "select", pageId });
		return originalSelect.call(this, pageId);
	};
	const request = async (path: string, body?: unknown) => {
		const response = await fetch(`${channel}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`QA channel ${response.status}`);
		return response.json();
	};
	const waitFor = async (description: string, ready: () => boolean) => {
		const deadline = Date.now() + 25_000;
		while (!ready()) {
			if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
	};
	const input = () =>
		element.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="${t("panels.browser.pageInput")}"]`,
		);
	const pageSelect = () =>
		element.querySelector<HTMLSelectElement>(
			`select[aria-label="${t("panels.browser.page")}"]`,
		);
	const click = (key: Parameters<typeof t>[0], text = false) => {
		const button = [...element.querySelectorAll("button")].find((node) =>
			text
				? node.textContent === t(key)
				: node.getAttribute("aria-label") === t(key),
		);
		if (!button || button.disabled)
			throw new Error(`Unavailable control: ${key}`);
		button.click();
	};
	const picker = () =>
		element.querySelector<HTMLButtonElement>(
			`button[aria-label="${t("panels.browser.pickElement")}"][aria-describedby]`,
		);
	const transferring = () =>
		element.textContent?.includes(t("panels.browser.controlPending")) === true;
	const preview = () => {
		const surface = picker();
		const rect = surface?.parentElement?.querySelector("svg[viewBox] rect");
		if (!rect) return undefined;
		return {
			x: Number(rect.getAttribute("x")),
			y: Number(rect.getAttribute("y")),
			width: Number(rect.getAttribute("width")),
			height: Number(rect.getAttribute("height")),
			label: surface?.parentElement
				?.querySelector(
					`#${CSS.escape(surface.getAttribute("aria-describedby") ?? "")}`,
				)
				?.querySelector("span")?.textContent,
		};
	};
	function frame() {
		const image = element.querySelector<HTMLImageElement>(
			`img[alt="${t("panels.browser.pageView")}"]`,
		);
		if (
			!image?.complete ||
			!image.naturalWidth ||
			observedFrame?.src !== image.src
		)
			return undefined;
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		context.drawImage(image, 0, 0);
		return {
			width: canvas.width,
			height: canvas.height,
			viewport: observedFrame.capture.viewport,
			pixel: [...context.getImageData(4, 4, 1, 1).data],
			src: image.src,
		};
	}
	try {
		while (!stopped) {
			const config: Configuration = await request("/configuration");
			if (!config.revision || config.revision === revision) {
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
				continue;
			}
			revision = config.revision;
			currentAction = config.action;
			if (config.action === "backend-ready") {
				await probeSelectedDureBackend();
			} else if (config.action === "attach") {
				focusAddressBeforeObservation =
					config.focusAddressBeforeObservation === true;
				const resource = parseBrowserResource(config.resource);
				if (!resource || !config.pageId)
					throw new Error("Invalid native fixture resource");
				const authority =
					await resolveSelectedDureBackendRouteAuthority(undefined);
				await createDureBrowserClient(authority).list();
				useStore.setState((state) => ({
					uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
				}));
				root = createRoot(element);
				root.render(
					<DockviewReact
						components={{ browser: BrowserPanel }}
						onReady={(event) => {
							api = event.api;
						}}
					/>,
				);
				await waitFor("React Dockview ready", () => !!api);
				if (!api) throw new Error("React Dockview unavailable");
				api.layout(element.clientWidth, element.clientHeight);
				api.addPanel({
					id: "browser:native-panel-proof",
					component: "browser",
					title: "Native Browser QA",
					params: {
						url: config.url,
						browserBinding: {
							authority,
							resource,
							workspaceId: resource.workspace_id,
							pageId: config.pageId,
						},
					},
				});
				if (config.presentation) {
					spaceId = useStore
						.getState()
						.addSpace({ name: "Browser presentation QA" });
					registerDockview(spaceId, api);
					stopRegistry = startRegistrySync();
				}
			} else if (config.action === "frame-fail") {
				const session = observedSession;
				if (!session || resumeFrames)
					throw new Error("Frame probe is not ready");
				const original = session.client.frame;
				session.client.frame = async (page) => {
					await original.call(session.client, page);
					throw new Error("browser_qa_frame_response_lost");
				};
				resumeFrames = () => {
					session.client.frame = original;
					resumeFrames = undefined;
				};
				await waitFor(
					"frame failure reaches the native product panel",
					() =>
						session.read().error?.message ===
							"browser_qa_frame_response_lost" &&
						element.textContent?.includes(t("ipc.browser.requestFailed")) ===
							true,
				);
			} else if (config.action === "frame-resume") {
				if (!resumeFrames) throw new Error("Frame fault has not started");
				resumeFrames();
				await waitFor(
					"fresh frame clears the read failure without replaying input",
					() =>
						!!observedSession?.read().frame &&
						!observedSession.read().error &&
						!element.textContent?.includes(t("ipc.browser.requestFailed")),
				);
			} else if (config.action === "scroll") {
				const image = element.querySelector<HTMLImageElement>(
					`img[alt="${t("panels.browser.pageView")}"]`,
				);
				const surface = image?.parentElement;
				if (!image || !surface || input()?.readOnly !== false)
					throw new Error("Scroll surface is not ready");
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 1;
				const context = canvas.getContext("2d")!;
				const pixel = () => {
					context.drawImage(image, 4, 4, 1, 1, 0, 0, 1, 1);
					return context.getImageData(0, 0, 1, 1).data[0];
				};
				const timings: NonNullable<typeof refreshTimings> = [];
				refreshTimings = timings;
				const latencies: number[] = [];
				try {
					for (let sample = 0; sample < 12; sample++) {
						const before = pixel();
						const bounds = surface.getBoundingClientRect();
						const start = performance.now();
						surface.dispatchEvent(
							new WheelEvent("wheel", {
								bubbles: true,
								deltaY: 100,
								deltaMode: 0,
								clientX: bounds.left + 100,
								clientY: bounds.top + 100,
							}),
						);
						await waitFor(
							"wheel reaches the displayed Chromium frame",
							() => image.complete && Math.abs(pixel() - before) >= 8,
						);
						latencies.push(performance.now() - start);
						await new Promise((resolve) =>
							setTimeout(resolve, 17 * (sample % 3)),
						);
					}
					interaction = { timings, latencies };
				} finally {
					refreshTimings = undefined;
				}
			} else if (config.action === "address-blur") {
				const address = element.querySelector<HTMLInputElement>(
					`input[aria-label="${t("panels.browser.address")}"]`,
				)!;
				address.focus();
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)!.set!.call(address, "");
				address.dispatchEvent(new Event("input", { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (address.value !== "")
					throw new Error("Address draft was not cleared");
				address.blur();
				await new Promise((resolve) => setTimeout(resolve, 0));
			} else if (config.action === "native-ime-focus") {
				if (import.meta.env.VITE_DURE_BROWSER_QA_OS_IME !== "1")
					throw new Error(
						"Native IME focus requires the exclusive QA entry point",
					);
				const receiver = input();
				const view = observedSession?.read();
				if (
					!receiver ||
					receiver.readOnly ||
					!view?.page ||
					!view.control?.controller
				)
					throw new Error(
						"Native IME receiver has no page/controller authority",
					);
				if (stopNativeIme)
					throw new Error("Native IME capture already started");
				const events: NonNullable<typeof nativeIme>["events"] = [];
				const captureState = {
					page: view.page,
					controller: view.control.controller,
					events,
					overflow: false,
				};
				nativeIme = captureState;
				const capture = (event: Event) => {
					if (events.length >= 128) {
						captureState.overflow = true;
						return;
					}
					events.push({
						type: event.type,
						trusted: event.isTrusted,
						connected: receiver.isConnected,
						...(event instanceof CompositionEvent || event instanceof InputEvent
							? { data: event.data }
							: {}),
						...(event instanceof KeyboardEvent
							? { code: event.code, isComposing: event.isComposing }
							: {}),
					});
				};
				const types = [
					"keydown",
					"keyup",
					"compositionstart",
					"compositionupdate",
					"compositionend",
					"input",
				];
				for (const type of types) receiver.addEventListener(type, capture);
				stopNativeIme = () => {
					for (const type of types) receiver.removeEventListener(type, capture);
				};
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				await getCurrentWindow().setFocus();
				receiver.focus();
				await waitFor(
					"exact native IME input focus",
					() => document.hasFocus() && document.activeElement === receiver,
				);
			} else if (config.action === "native-ime-observe") {
				if (!nativeIme) throw new Error("Native IME capture has not started");
				await waitFor(
					"OS composition and final native keyup",
					() =>
						!!nativeIme?.events.some(
							(event) => event.type === "compositionend",
						) &&
						!!nativeIme?.events.some(
							(event) => event.type === "keyup" && event.code === "Space",
						),
				);
				await waitFor(
					"native IME input settled",
					() => !!observedSession && !observedSession.read().submitting,
				);
				stopNativeIme?.();
			} else if (
				config.action === "select-page" ||
				config.action === "select-pending" ||
				config.action === "follow"
			) {
				if (config.action === "select-pending")
					await waitFor(
						"pending transfer before viewer selection",
						transferring,
					);
				const value = config.action === "follow" ? "" : config.pageId;
				if (value === undefined) throw new Error("Missing page selection");
				await waitFor("page selector ready", () => {
					const select = pageSelect();
					return (
						!!select &&
						!select.disabled &&
						[...select.options].some((option) => option.value === value)
					);
				});
				const select = pageSelect()!;
				select.value = value;
				select.dispatchEvent(new Event("change", { bubbles: true }));
			} else if (config.action === "profile-new") {
				const button = [
					...document.querySelectorAll<HTMLButtonElement>(
						'[role="dialog"] button',
					),
				].find((node) => node.textContent === t("panels.browser.newProfile"));
				if (!button || button.disabled)
					throw new Error("Unavailable new profile control");
				button.click();
				await waitFor(
					"new profile form",
					() =>
						!!document.querySelector(
							`input[aria-label="${t("panels.browser.profileName")}"]`,
						),
				);
			} else if (config.action === "profile-create") {
				const field = document.querySelector<HTMLInputElement>(
					`input[aria-label="${t("panels.browser.profileName")}"]`,
				);
				if (!field || !config.profileName)
					throw new Error("Missing profile name input");
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)!.set!.call(field, config.profileName);
				field.dispatchEvent(new Event("input", { bubbles: true }));
				const toggle = document.querySelector<HTMLButtonElement>(
					`[role="switch"][aria-label="${t("panels.browser.nativeUserAgent")}"]`,
				);
				if (!toggle) throw new Error("Missing profile user-agent option");
				if (
					(toggle.getAttribute("aria-checked") === "true") !==
					!!config.nativeUserAgent
				)
					toggle.click();
				const button = () =>
					[
						...document.querySelectorAll<HTMLButtonElement>(
							'[role="dialog"] button',
						),
					].find(
						(node) =>
							node.textContent === t("panels.browser.createProfileAndSwitch"),
					);
				await waitFor(
					"profile create enabled",
					() => !!button() && !button()!.disabled,
				);
				button()!.click();
				await waitFor(
					"created profile switched",
					() =>
						!document.querySelector('[role="dialog"]') &&
						input()?.readOnly === false,
				);
			} else if (config.action?.startsWith("profile-delete-")) {
				const key =
					config.action === "profile-delete-open"
						? "panels.browser.deleteProfile"
						: config.action === "profile-delete-cancel"
							? "common.cancel"
							: "panels.browser.confirmDeleteProfile";
				const button = [
					...document.querySelectorAll<HTMLButtonElement>(
						'[role="dialog"] button',
					),
				].find((node) => node.textContent === t(key));
				if (!button || button.disabled)
					throw new Error(`Unavailable profile deletion control: ${key}`);
				button.click();
				if (config.action === "profile-delete-open")
					await waitFor(
						"profile deletion confirmation",
						() =>
							!document.querySelector('[role="dialog"] select') &&
							[...document.querySelectorAll('[role="dialog"] button')].some(
								(node) =>
									node.textContent === t("panels.browser.confirmDeleteProfile"),
							),
					);
				else if (config.action === "profile-delete-cancel")
					await waitFor(
						"profile deletion canceled",
						() =>
							!!document.querySelector(
								`select[aria-label="${t("panels.browser.profileDestination")}"]`,
							),
					);
				else
					await waitFor(
						"profile deletion settled",
						() =>
							!document.querySelector('[role="dialog"]') &&
							!!config.pageId &&
							!!pageSelect() &&
							![...pageSelect()!.options].some(
								(option) => option.value === config.pageId,
							),
					);
			} else if (config.action === "profiles-open") {
				click("panels.browser.profiles", true);
				await waitFor(
					"saved profile catalog",
					() =>
						!!document
							.querySelector<HTMLSelectElement>(
								`select[aria-label="${t("panels.browser.profileDestination")}"]`,
							)
							?.querySelector(`option[value="${config.profileId}"]`),
				);
			} else if (
				config.action === "profile-switch" ||
				config.action === "profile-clone"
			) {
				const select = document.querySelector<HTMLSelectElement>(
					`select[aria-label="${t("panels.browser.profileDestination")}"]`,
				);
				if (!select || !config.profileId)
					throw new Error("Missing saved profile dialog");
				select.value = config.profileId;
				select.dispatchEvent(new Event("change", { bubbles: true }));
				const key =
					config.action === "profile-switch"
						? "panels.browser.profileSwitch"
						: "panels.browser.profileClone";
				const button = () =>
					[
						...document.querySelectorAll<HTMLButtonElement>(
							'[role="dialog"] button',
						),
					].find((node) => node.textContent === t(key));
				await waitFor(
					"profile confirmation enabled",
					() => !!button() && !button()!.disabled,
				);
				button()!.click();
				await waitFor(
					"profile operation settled",
					() =>
						!document.querySelector('[role="dialog"]') &&
						input()?.readOnly === false,
				);
			} else if (config.action === "take") {
				click("panels.browser.takeControl", true);
				if (config.pending)
					await waitFor("pending control transfer", transferring);
				else
					await waitFor(
						"human controller and settled viewport",
						() => input()?.readOnly === false,
					);
			} else if (
				config.action === "compose" ||
				config.action === "compose-start" ||
				config.action === "compose-end"
			) {
				const receiver =
					config.action === "compose-end" ? compositionReceiver : input();
				if (!receiver) throw new Error("Composition receiver is missing");
				if (config.action !== "compose-end") {
					if (receiver.readOnly) throw new Error("Product input is not ready");
					compositionReceiver = receiver;
					receiver.dispatchEvent(
						new CompositionEvent("compositionstart", {
							data: "",
							bubbles: true,
						}),
					);
					receiver.value = "ㅎ";
					receiver.dispatchEvent(
						new InputEvent("input", {
							data: "ㅎ",
							inputType: "insertCompositionText",
							isComposing: true,
							bubbles: true,
						}),
					);
				}
				if (config.action !== "compose-start") {
					if (!config.text) throw new Error("Composition text is missing");
					receiver.value = config.text;
					receiver.dispatchEvent(
						new CompositionEvent("compositionend", {
							data: config.text,
							bubbles: true,
						}),
					);
					receiver.dispatchEvent(
						new InputEvent("input", {
							data: config.text,
							inputType: "insertText",
							bubbles: true,
						}),
					);
					compositionReceiver = undefined;
					await waitFor(
						"composition input settled",
						() => !!observedSession && !observedSession.read().submitting,
					);
				}
			} else if (config.action === "preview") {
				if (!picker()) click("panels.browser.pickElement");
				await waitFor("element picker", () => !!picker());
				const surface = picker()!;
				const image = frame();
				if (!image || !config.point)
					throw new Error("Preview coordinates missing");
				const bounds = surface.getBoundingClientRect();
				// Fixture points use page CSS pixels, independently of Retina density.
				const scale = Math.min(
					bounds.width / image.viewport.width,
					bounds.height / image.viewport.height,
				);
				surface.dispatchEvent(
					new PointerEvent("pointermove", {
						bubbles: true,
						clientX: bounds.left + config.point.x * scale,
						clientY: bounds.top + config.point.y * scale,
					}),
				);
				if (config.label)
					await waitFor(
						"actual element highlight",
						() => preview()?.label === config.label,
					);
				else await waitFor("empty point clears highlight", () => !preview());
			} else if (config.action === "preview-leave") {
				const surface = picker();
				if (!surface) throw new Error("Picker missing before pointer leave");
				surface.dispatchEvent(
					new PointerEvent("pointerout", {
						bubbles: true,
						relatedTarget: null,
					}),
				);
				await waitFor("pointer leave clears highlight", () => !preview());
			} else if (config.action === "return") {
				click("panels.browser.returnControl", true);
				if (config.pending)
					await waitFor("pending control transfer", transferring);
				await waitFor(
					"returned controller disables product input",
					() => input()?.readOnly === true,
				);
				await waitFor(
					"controller handoff removes picker and highlight",
					() => !picker() && !preview(),
				);
			} else if (config.action === "reconnect") {
				const previousInput = input();
				if (!previousInput) throw new Error("Browser view is not connected");
				click("panels.browser.reconnect");
				await waitFor("reconnected Browser input surface", () => {
					const currentInput = input();
					return !!currentInput && currentInput !== previousInput;
				});
			} else if (config.action === "close") {
				click("panels.browser.closeBrowser");
				await waitFor("inline browser close confirmation", () =>
					[...element.querySelectorAll("button")].some(
						(node) => node.textContent === t("panels.browser.closeBrowser"),
					),
				);
				click("panels.browser.closeBrowser", true);
				await waitFor("closed Browser panel", () => input() === null);
				stopped = true;
			}
			if (config.action !== "close" && config.action !== "backend-ready") {
				if (config.controlled !== undefined)
					await waitFor(
						"expected input authority",
						() => input()?.readOnly === !config.controlled,
					);
				if (config.pageId && config.action !== "profile-delete-confirm")
					await waitFor(
						"selected page binding",
						() =>
							api?.getPanel("browser:native-panel-proof")?.params
								?.browserBinding?.pageId === config.pageId,
					);
				if (config.action === "select-pending") {
					await waitFor(
						"pending viewer discards the old frame",
						() => transferring() && input()?.readOnly === true && !frame(),
					);
				} else if (config.action !== "profile-delete-confirm")
					await waitFor("current native frame", () => {
						const current = frame();
						return (
							!!current &&
							(config.action !== "presentation-watch" ||
								observedFrame?.capture.page.page_id === config.pageId) &&
							(!config.color ||
								config.color.every(
									(channel, index) =>
										Math.abs(channel - current.pixel[index]) <= 4,
								))
						);
					});
			}
			await request("/reports", {
				type: "browser-panel",
				spaceId,
				revision,
				action: config.action,
				result: "passed",
				interaction,
				userAgent: navigator.userAgent,
				frame: frame(),
				preview: preview(),
				pickerOpen: !!picker(),
				inputReadOnly: input()?.readOnly,
				...(config.action.startsWith("native-ime-")
					? {
							nativeIme,
							inputFocused:
								document.hasFocus() && document.activeElement === input(),
							inputLabel: input()?.getAttribute("aria-label"),
						}
					: {}),
				transferring: transferring(),
				binding: api?.getPanel("browser:native-panel-proof")?.params
					?.browserBinding,
				address: element.querySelector<HTMLInputElement>(
					`input[aria-label="${t("panels.browser.address")}"]`,
				)?.value,
				status: element.textContent,
				selectionTrace: selectionTrace.splice(0),
			});
		}
	} catch (error) {
		await request("/reports", {
			type: "browser-panel",
			revision,
			action: currentAction,
			result: "failed",
			error: String(error),
			details: error,
			visibility: document.visibilityState,
			status: element.textContent,
			binding: api?.getPanel("browser:native-panel-proof")?.params
				?.browserBinding,
			selectionTrace,
			nativeIme,
		});
	} finally {
		resumeFrames?.();
		stopNativeIme?.();
		stopRegistry?.();
		if (spaceId && api) unregisterDockview(spaceId, api);
		root?.unmount();
		BrowserPaneSession.prototype.refresh = originalRefresh;
		BrowserPaneSession.prototype.selectPage = originalSelect;
		element.remove();
	}
}
