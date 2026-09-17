import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { TerminalView } from "@/components/terminal/TerminalView";
import { homeDir, readFile } from "@/lib/ipc";
import { attachPredecessorRealmForQa } from "@/lib/ipc/webviewRealmQa";
import { currentWebviewInstanceIdentity } from "@/lib/platform/webviewInstanceIdentity";
import { qaLog } from "@/lib/qa/qaLog";
import { StructuredTerminalQaProbe } from "@/lib/terminal/qa/structuredTerminalQaProbe";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

const proof = new URLSearchParams(location.search).get("qaWebviewRealm");
const storageKey = `qa-webview-realm:${proof}`;
type Session = { sessionId: string; workspaceId: string };
type Checkpoint = { previous: string; round: number; sessions: Session[] };

function requireFact(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}

/** Two real terminal surfaces across an unbound reload and a bound reload.
 * Uses disposable Host input only; the native window cannot take OS focus. */
export function WebviewRealmQaRoot() {
	const [surfaces, setSurfaces] = useState<
		Array<Session & { probe: StructuredTerminalQaProbe }>
	>([]);
	useEffect(() => {
		if (!proof) return;
		const probes: StructuredTerminalQaProbe[] = [];
		let failure: unknown;
		const run = async () => {
			const home = await homeDir();
			requireFact(
				home.includes("/dure-webview-realm.") && home.endsWith("/home"),
				"Realm QA escaped its disposable HOME",
			);
			const identity = currentWebviewInstanceIdentity().instanceId;
			const markerPrefix = `HMUX_WINDOW_QA_${proof.replace(/-/g, "").slice(0, 12).toUpperCase()}`;
			const saved = sessionStorage.getItem(storageKey);
			if (!saved) {
				sessionStorage.setItem(
					storageKey,
					JSON.stringify({ previous: identity, round: 0, sessions: [] }),
				);
				location.reload();
				return;
			}
			const checkpoint: Checkpoint = JSON.parse(saved);
			requireFact(
				checkpoint.previous !== identity,
				"Reload retained the outgoing JavaScript realm",
			);
			if (checkpoint.sessions.length === 0) {
				const deadline = performance.now() + 30_000;
				while (checkpoint.sessions.length === 0) {
					try {
						const fixture = JSON.parse(
							(await readFile(`${home}/realm-sessions.json`)).content,
						);
						requireFact(
							fixture.proof === proof && fixture.sessions.length === 2,
							"Mismatched realm fixture",
						);
						checkpoint.sessions = fixture.sessions;
					} catch (error) {
						if (performance.now() >= deadline) throw error;
						await new Promise<void>((resolve) => setTimeout(resolve, 100));
					}
				}
			}
			let rejection: unknown;
			try {
				await attachPredecessorRealmForQa({
					...checkpoint.sessions[0],
					webviewInstanceId: checkpoint.previous,
				});
			} catch (error) {
				rejection = error;
			}
			requireFact(
				JSON.stringify(rejection)?.includes("hmux_webview_instance_stale"),
				`Outgoing ${checkpoint.round === 0 ? "unbound" : "bound"} realm was not rejected: ${JSON.stringify(rejection)}`,
			);
			const next = checkpoint.sessions.map((session, index) => {
				const probe = new StructuredTerminalQaProbe(`realm-${index}`, {
					onConnected: () => () => {},
					onFocused: () => {},
					onHydrationChange: () => {},
					onSynchronized: () => {},
					onPresented: () => {},
					onError: (error) => {
						failure = error;
					},
				});
				probes.push(probe);
				return { ...session, probe };
			});
			setSurfaces(next);
			const deadline = performance.now() + 30_000;
			while (
				!probes.every(
					(probe) => probe.connected && (probe.bufferState()?.columns ?? 0) > 0,
				)
			) {
				if (failure) throw failure;
				requireFact(
					performance.now() < deadline,
					"Current realm did not recover both presented terminal surfaces",
				);
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
			}
			for (const [index, probe] of probes.entries()) {
				const marker = `${markerPrefix}_${index === 0 ? "A" : "B"}_${String(checkpoint.round).padStart(4, "0")}`;
				if (checkpoint.round === 1)
					requireFact(
						probe.bufferState(`${markerPrefix}_${index === 0 ? "A" : "B"}_0000`)
							?.logicalScrollbackMarkerPresent,
						"Reload lost the prior terminal output",
					);
				const escapedMarker = [...marker]
					.map(
						(character) =>
							`\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
					)
					.join("");
				const observed = await probe.observeInput(
					marker,
					`printf '${escapedMarker}\\n'\r`,
					{ onReceipt: () => {}, onProjection: () => {} },
				);
				requireFact(
					observed.markerCounts.painted === 1 &&
						observed.markerCounts.projection === 1,
					"Recovered input was lost or duplicated",
				);
			}
			const window = getCurrentWindow();
			requireFact(
				(await window.isVisible()) && !(await window.isFocused()),
				"Realm QA must remain visible and unfocused",
			);
			if (checkpoint.round === 0) {
				sessionStorage.setItem(
					storageKey,
					JSON.stringify({ ...checkpoint, previous: identity, round: 1 }),
				);
				location.reload();
				return;
			}
			qaLog("webview-realm", {
				proof,
				result: "passed",
				rounds: 2,
				sessions: checkpoint.sessions.map((session) => session.sessionId),
				surfaces: 2,
				inputReceipts: 4,
				visible: true,
				focused: false,
			});
		};
		void run().catch((error) =>
			qaLog("webview-realm", { proof, result: "failed", error: String(error) }),
		);
		return () => {
			for (const probe of probes) probe.dispose();
		};
	}, []);
	return (
		<main className="flex h-screen w-screen">
			{surfaces.map((surface) => (
				<section key={surface.sessionId} className="min-w-0 flex-1">
					<TerminalView
						sessionId={surface.sessionId}
						kind="pty"
						binding={hmuxStandaloneBinding(
							surface.sessionId,
							surface.workspaceId,
						)}
						windowFocusProbe={surface.probe}
					/>
				</section>
			))}
		</main>
	);
}
