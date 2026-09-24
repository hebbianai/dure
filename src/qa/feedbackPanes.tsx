import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { type DockviewApi, DockviewReact } from "dockview-react";
import { createRoot } from "react-dom/client";
import { MobileSimulatorPanel } from "@/components/panels/mobile/MobileSimulatorPanel";
import { webviewStorageOptions } from "@/lib/ipc/core";
import {
	type MobileRunProfile,
	readMobileRunProfiles,
} from "@/lib/mobileSimulator/profile";
import { qaLog } from "@/lib/qa/qaLog";
import { definePaneAction } from "@/lib/workspace/pane/paneAction";
import {
	invokePaneAction,
	paneActionSnapshot,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";

/** Real Dockview, React, WKWebView and native request broker. Device identities
 * and the counted mutation are fixtures; this probe never invokes a mobile SDK. */
export async function runFeedbackPaneProbe() {
	const params = new URLSearchParams(location.search);
	const proof = params.get("qaFeedbackPanes");
	if (!import.meta.env.DEV || !proof) return;
	const role = params.get("peer") === "1" ? "peer" : "main";
	const windowLabel = getCurrentWebviewWindow().label;
	const mobileId = `qa-feedback-mobile-${role}`;
	const controlId = `qa-feedback-${role}`;
	const device =
		role === "main"
			? { platform: "ios" as const, id: "11111111-2222-3333-4444-555555555555" }
			: { platform: "android" as const, id: "emulator-9998" };
	const original: MobileRunProfile = {
		projectPath: "/qa/project",
		artifactPath: "old-artifact",
		buildCommand: "",
		appId: "com.dure.qa",
		url: "",
		device,
	};
	const element = document.createElement("div");
	element.style.cssText = "position:absolute;inset:0";
	document.body.append(element);
	let api: DockviewApi | undefined;
	let mutations = 0;
	let mounted: (() => void) | undefined;
	const wait = async (ready: () => boolean) => {
		const deadline = Date.now() + 15000;
		while (!ready()) {
			if (Date.now() > deadline) throw new Error("Feedback pane did not mount");
			await new Promise((done) => setTimeout(done, 25));
		}
	};
	const check = (condition: unknown, message: string) => {
		if (!condition) throw new Error(message);
	};
	const read = async () => {
		const result = await invokePaneAction(mobileId, "mobile.status");
		if (!result.ok || !result.result || !("value" in result.result))
			throw new Error("Mobile status unavailable");
		return result.result.value as { profiles: MobileRunProfile[] };
	};
	const addMobile = (profiles: MobileRunProfile[]) => {
		api!.addPanel({
			id: mobileId,
			component: "mobileSimulator",
			params: { device, profiles },
			inactive: true,
			renderer: "always",
		});
	};
	createRoot(element).render(
		<DockviewReact
			components={{
				mobileSimulator: MobileSimulatorPanel,
				blank: () => <div />,
			}}
			onReady={(event) => {
				api = event.api;
				api.addPanel({ id: `qa-blank-${role}`, component: "blank" });
				addMobile([original]);
			}}
		/>,
	);
	await wait(() => Boolean(paneActionSnapshot(mobileId)));
	registerPaneActions({
		owner: {},
		paneId: controlId,
		status: "attached",
		actions: {
			"qa.profiles": definePaneAction(
				{ description: "Verify profile receipt consistency", parameters: {} },
				async () => {
					const save = async (
						artifactPath: string,
						projectPath = original.projectPath,
					) => {
						const result = await invokePaneAction(
							mobileId,
							"mobile.profile.save",
							{
								platform: device.platform,
								deviceId: device.id,
								projectPath,
								appId: original.appId,
								artifactPath,
							},
						);
						check(
							result.ok && result.result?.outcome === "applied",
							"Profile save was not applied",
						);
					};
					await save("new-artifact");
					check(
						(await read()).profiles[0]?.artifactPath === "new-artifact",
						"Save/status returned different artifacts",
					);
					await save("second-artifact", "/qa/second");
					const expected = readMobileRunProfiles([
						{ ...original, artifactPath: "new-artifact" },
						{
							...original,
							projectPath: "/qa/second",
							artifactPath: "second-artifact",
						},
					]);
					check(
						JSON.stringify((await read()).profiles) ===
							JSON.stringify(expected),
						"Sequential save lost a profile",
					);
					const layout = api!.toJSON();
					api!.removePanel(api!.getPanel(mobileId)!);
					await wait(() => !paneActionSnapshot(mobileId));
					api!.fromJSON(layout);
					await wait(() => Boolean(paneActionSnapshot(mobileId)));
					check(
						JSON.stringify((await read()).profiles) ===
							JSON.stringify(expected),
						`Serialized profile was lost after remount: ${JSON.stringify({ restored: await read(), expected, layout })}`,
					);
					return {
						outcome: "applied",
						value: {
							profiles: expected,
							remounted: true,
							windowLabel,
							userAgent: navigator.userAgent,
						},
					};
				},
			),
			"qa.mount": definePaneAction(
				{ description: "Mount a counted fixture action", parameters: {} },
				async () => {
					mounted?.();
					mounted = registerPaneActions({
						owner: {},
						paneId: "qa-feedback-recovered",
						status: "attached",
						actions: {
							"qa.mutate": definePaneAction(
								{ description: "Count an admitted operation", parameters: {} },
								async () => ({
									outcome: "pending",
									value: { mutations: ++mutations },
								}),
							),
							"qa.fail": definePaneAction(
								{
									description: "Fail after entering the handler",
									parameters: {},
								},
								async () => {
									++mutations;
									throw new Error("Deliberate post-invocation failure");
								},
							),
						},
					});
					return { outcome: "applied" };
				},
			),
			"qa.count": definePaneAction(
				{ description: "Observe execution count", parameters: {} },
				async () => ({ outcome: "unchanged", value: mutations }),
			),
		},
	});
	if (role === "main") {
		new WebviewWindow(`win-${Date.now()}-584`, {
			...(await webviewStorageOptions()),
			url: `index.html?qaWindowSmokeController=1&qaFeedbackPanes=${proof}&peer=1`,
			visible: false,
			focus: false,
			focusable: false,
			backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
		});
	}
	qaLog(`feedback-pane-${role}`, {
		proof,
		windowLabel,
		mobileId,
		controlId,
		ready: true,
	});
}
