import { type DockviewApi, DockviewReact } from "dockview-react";
import { createRoot } from "react-dom/client";
import { MobileSimulatorPanel } from "@/components/panels/mobile/MobileSimulatorPanel";
import { t } from "@/lib/i18n";
import { feedbackCaptureMainWindow } from "@/lib/ipc/feedback";
import { mobileSimulator } from "@/lib/ipc/mobileSimulator";
import { qaLog } from "@/lib/qa/qaLog";
import { invokePaneAction } from "@/lib/workspace/pane/paneActionRegistry";

/** Background WKWebView proof with a simulator created solely by its runner. */
export async function runMobileSimulatorProbe() {
	if (!import.meta.env.DEV) return;
	const params = new URLSearchParams(location.search);
	const id = params.get("qaMobileSimulator");
	const fixture = params.get("fixture");
	if (!id || !fixture) throw new Error("Mobile simulator QA target is missing");
	const appPath = new TextDecoder().decode(
		Uint8Array.from(atob(fixture.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
			c.charCodeAt(0),
		),
	);
	const platform = params.get("platform") === "android" ? "android" : "ios";
	const target = { platform, id } as const;
	const element = document.createElement("div");
	element.style.cssText = "position:absolute;inset:0";
	document.body.append(element);
	const root = createRoot(element);
	let api: DockviewApi | undefined;
	const waitFor = async (read: () => boolean) => {
		const deadline = Date.now() + 20000;
		while (!read()) {
			if (Date.now() > deadline)
				throw new Error(
					`Mobile pane did not become ready: ${element.textContent}`,
				);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	try {
		const catalog = await mobileSimulator.list();
		const device = catalog.devices.find((device) => device.id === id);
		if (
			!device ||
			(platform === "ios"
				? !device.name.startsWith("Dure Mobile QA ")
				: !id.startsWith("emulator-"))
		)
			throw new Error("QA may only operate its disposable simulator");
		const appId =
			platform === "android"
				? "com.dure.mobileqa"
				: "com.dure.mobile-simulator-qa";
		const profile = {
			projectPath: appPath.slice(0, appPath.lastIndexOf("/")),
			buildCommand: "printf mobile-profile-build",
			artifactPath: appPath,
			appId,
			url: "mobileqa://home",
			device: target,
		};
		let failedBuild = false;
		try {
			await mobileSimulator.run(target, {
				...profile,
				buildCommand: "echo deliberate-build-failure; exit 7",
			});
		} catch (error) {
			failedBuild = String(error).includes("deliberate-build-failure");
		}
		if (!failedBuild)
			throw new Error("Failed builds must stop before installation");
		if (platform === "android") {
			let absent = false;
			try {
				await mobileSimulator.act(target, { kind: "launch", appId });
			} catch {
				absent = true;
			}
			if (!absent) throw new Error("Failed build installed the app");
		}
		const built = await mobileSimulator.run(target, profile);
		if (!built.buildOutput.includes("mobile-profile-build"))
			throw new Error("Profile build output missing");
		if (platform === "android") {
			const first = await mobileSimulator.capture(target);
			await mobileSimulator.act(target, {
				kind: "gesture",
				start: { x: 0.5, y: 0.4 },
				end: { x: 0.5, y: 0.4 },
				width: first.width,
				height: first.height,
			});
			await mobileSimulator.act(target, {
				kind: "gesture",
				start: { x: 0.5, y: 0.7 },
				end: { x: 0.5, y: 0.3 },
				width: first.width,
				height: first.height,
			});
			await mobileSimulator.act(target, { kind: "type", text: "Dure" });
			const report = await mobileSimulator.report(target, appId);
			if (
				!report.logs.includes("touch:") ||
				!report.logs.includes("key:") ||
				!report.logs.includes("link:mobileqa://home")
			)
				throw new Error(
					`Android did not receive touch/text: ${JSON.stringify(report)}`,
				);
			await mobileSimulator.act(target, { kind: "rotate", landscape: true });
			const deadline = Date.now() + 10000;
			while (true) {
				const frame = await mobileSimulator.capture(target);
				if (frame.width > frame.height) break;
				if (Date.now() > deadline) throw new Error("Android did not rotate");
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			let refused = false;
			try {
				await mobileSimulator.act(target, {
					kind: "gesture",
					start: { x: 0.5, y: 0.4 },
					end: { x: 0.5, y: 0.4 },
					width: first.width,
					height: first.height,
				});
			} catch {
				refused = true;
			}
			if (!refused) throw new Error("Stale orientation input was not refused");
			await mobileSimulator.act(target, { kind: "rotate", landscape: false });
		}
		root.render(
			<DockviewReact
				components={{
					mobileSimulator: MobileSimulatorPanel,
					blank: () => <div />,
				}}
				onReady={(event) => {
					api = event.api;
					api.addPanel({
						id: "qa-mobile",
						component: "mobileSimulator",
						params: { device: target, profiles: [profile] },
					});
				}}
			/>,
		);
		await waitFor(() =>
			Boolean(element.querySelector<HTMLImageElement>("img")?.naturalWidth),
		);
		const first = element.querySelector<HTMLImageElement>("img");
		if (
			!first ||
			Math.min(first.naturalWidth, first.naturalHeight) < 300 ||
			Math.max(first.naturalWidth, first.naturalHeight) < 600
		)
			throw new Error("Real screenshot did not decode in WKWebView");
		const width = first.naturalWidth;
		const height = first.naturalHeight;
		const dataUrl = first.src;
		const panel = api?.getPanel("qa-mobile");
		if (!panel || !api) throw new Error("Simulator pane is missing");
		const persisted = api.toJSON();
		api.addPanel({
			id: "qa-blank",
			component: "blank",
			position: { referencePanel: panel.id, direction: "within" },
		});
		await waitFor(() => !element.querySelector("img"));
		panel.api.setActive();
		await waitFor(() =>
			Boolean(element.querySelector<HTMLImageElement>("img")?.naturalWidth),
		);
		api.fromJSON(persisted);
		await waitFor(() =>
			Boolean(element.querySelector<HTMLImageElement>("img")?.naturalWidth),
		);
		const restored = api.getPanel("qa-mobile")?.params?.device;
		if (restored?.id !== id || restored?.platform !== platform)
			throw new Error("Restoration lost the exact device selection");
		const commandCapture = await invokePaneAction(
			"qa-mobile",
			"mobile.capture",
			{ platform, deviceId: id },
		);
		if (!commandCapture.ok || commandCapture.result?.outcome !== "applied")
			throw new Error("Agent capture command failed");
		const status = await invokePaneAction("qa-mobile", "mobile.status");
		if (!status.ok) throw new Error("Agent status command failed");
		if (api.getPanel("qa-mobile")?.params?.profiles?.[0]?.appId !== appId)
			throw new Error("Saved profile was not restored");
		if (platform === "ios") {
			const toggle = Array.from(element.querySelectorAll("label"))
				.find((label) => label.textContent?.includes(t("panels.mobile.live")))
				?.querySelector("input");
			if (!toggle) throw new Error("Live iOS control missing");
			toggle.click();
			await waitFor(() =>
				Boolean(
					element
						.querySelector<HTMLImageElement>("img")
						?.src.startsWith("data:image/jpeg"),
				),
			);
			const frame = await mobileSimulator.capture(target);
			const touch = async (y: number, x = 0.5) =>
				mobileSimulator.act(target, {
					kind: "gesture",
					start: { x, y },
					end: { x, y },
					width: frame.width,
					height: frame.height,
				});
			const expectColor = async (expected: number[], label: string) => {
				const deadline = Date.now() + 10000;
				while (true) {
					const capture = await mobileSimulator.capture(target);
					const image = new Image();
					image.src = capture.dataUrl;
					await image.decode();
					const canvas = document.createElement("canvas");
					canvas.width = 1;
					canvas.height = 1;
					const context = canvas.getContext("2d");
					if (!context) throw new Error("Canvas unavailable");
					context.drawImage(
						image,
						Math.floor(capture.width * 0.025),
						Math.floor(capture.height * 0.14),
						1,
						1,
						0,
						0,
						1,
						1,
					);
					const pixel = context.getImageData(0, 0, 1, 1).data;
					if (
						expected.every(
							(value, index) => Math.abs(pixel[index] - value) <= 4,
						)
					)
						return;
					if (Date.now() > deadline)
						throw new Error(
							`iOS app did not render ${label}: ${Array.from(pixel)}`,
						);
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			};
			// A fresh iOS device asks to open the first custom URL. Accept inside
			// this disposable simulator through the same embedded HID input.
			await touch(0.55, 0.67);
			await expectColor([180, 100, 30], "deep link receipt");
			// UIKit fixture positions use points; this disposable iPhone has a 3x framebuffer.
			await touch((370 * 3) / frame.height);
			await expectColor([40, 150, 80], "button press receipt");
			await touch((470 * 3) / frame.height);
			await mobileSimulator.act(target, { kind: "type", text: "Dure" });
			await expectColor([120, 60, 190], "typed Dure receipt");
			toggle.click();
			await waitFor(() =>
				Boolean(
					element
						.querySelector<HTMLImageElement>("img")
						?.src.startsWith("data:image/png"),
				),
			);
			// Reconnection must succeed after the old worker has actually exited.
			toggle.click();
			await waitFor(() =>
				Boolean(
					element
						.querySelector<HTMLImageElement>("img")
						?.src.startsWith("data:image/jpeg"),
				),
			);
		}
		const paneCapture = await feedbackCaptureMainWindow().catch(
			() => undefined,
		);
		qaLog("mobile-simulator", {
			proof: id,
			platform,
			profileRun: true,
			liveIosInput: platform === "ios",
			agentCommands: true,
			result: "passed",
			userAgent: navigator.userAgent,
			width,
			height,
			dataUrl,
			paneCapture,
			restored,
			hiddenAndRestored: true,
		});
	} catch (error) {
		qaLog("mobile-simulator", {
			proof: id,
			result: "failed",
			error: String(error),
			dataUrl: (await mobileSimulator.capture(target).catch(() => undefined))
				?.dataUrl,
			paneCapture: await feedbackCaptureMainWindow().catch(() => undefined),
		});
	} finally {
		root.unmount();
		element.remove();
	}
}
