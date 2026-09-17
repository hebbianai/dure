import { emitTo, listen } from "@tauri-apps/api/event";
import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { webviewStorageOptions } from "@/lib/ipc/core";
import {
	openWebviewStorageQaNativePeer,
	reportWindowFocusQa,
	webviewStorageQaSnapshot,
} from "@/lib/ipc/windowFocusQa";
import { qaLog } from "@/lib/qa/qaLog";

const params = new URLSearchParams(location.search);
const proof = params.get("proof") ?? "";
const role = params.get("role") ?? "main";
const processPhase = params.get("processPhase");
const event = "qa:webview-storage";
const key = `qa:webview-storage:${proof}`;
const sentinel = `fixture:${proof}`;
type Observation = {
	proof: string;
	role: string;
	identifier: number[] | null;
	value?: string | null;
	error?: string;
};

function check(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function run() {
	check(
		import.meta.env.DEV && proof,
		"Storage probe requires a disposable dev run",
	);
	const options = await webviewStorageOptions();
	check(
		options.dataStoreIdentifier?.length === 16,
		"No configured disposable store",
	);
	const isolatedIdentifier = options.dataStoreIdentifier.map(
		(byte) => byte ^ 0xff,
	);
	const expected =
		role === "isolated" ? isolatedIdentifier : options.dataStoreIdentifier;
	const identifier = await webviewStorageQaSnapshot(proof);
	// No application modules or storage reads run before this native observation.
	check(
		JSON.stringify(identifier) === JSON.stringify(expected),
		"Native store differs from the explicit fixture store",
	);
	if (processPhase) {
		check(
			["seed", "restored", "isolated"].includes(processPhase),
			"Unknown process phase",
		);
		const value = localStorage.getItem(key);
		check(
			value === (processPhase === "restored" ? sentinel : null),
			"Process storage persistence is incorrect",
		);
		if (processPhase === "seed") localStorage.setItem(key, sentinel);
		await reportWindowFocusQa({
			proof,
			processPhase,
			result: "passed",
			identifier,
			value: localStorage.getItem(key),
			origin: location.origin,
		});
		return;
	}
	const observations: Observation[] = [];
	if (role !== "main") {
		const value = localStorage.getItem(key);
		check(
			value === (role === "isolated" ? null : sentinel),
			"Peer storage visibility is incorrect",
		);
		await emitTo("main", event, {
			proof,
			role,
			identifier,
			value,
		} satisfies Observation);
		return;
	}
	check(
		localStorage.getItem(key) === null,
		"Disposable store already contains the fixture sentinel",
	);
	localStorage.setItem(key, sentinel);
	observations.push({ proof, role, identifier, value: sentinel });
	async function observePeer(peerRole: string, create: () => Promise<unknown>) {
		let receive!: (observation: Observation) => void;
		const observed = new Promise<Observation>((resolve) => {
			receive = resolve;
		});
		const stop = await listen<Observation>(event, ({ payload }) => {
			if (payload.proof === proof && payload.role === peerRole)
				receive(payload);
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await create();
			const observation = await Promise.race([
				observed,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Missing storage peer ${peerRole}`)),
						15_000,
					);
				}),
			]);
			check(!observation.error, observation.error ?? "Storage peer failed");
			observations.push(observation);
		} finally {
			clearTimeout(timer);
			stop();
		}
	}
	async function createJsPeer(peerRole: string) {
		return new WebviewWindow("win-storage-js", {
			...(await webviewStorageOptions()),
			...(peerRole === "isolated"
				? { dataStoreIdentifier: isolatedIdentifier }
				: {}),
			url: `src/qa/webviewStorage.html?proof=${encodeURIComponent(proof)}&role=${peerRole}`,
			visible: false,
			focus: false,
			focusable: false,
			backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
		});
	}
	await observePeer("native", () => openWebviewStorageQaNativePeer(proof));
	let peer: WebviewWindow | undefined;
	await observePeer("js", async () => {
		peer = await createJsPeer("js");
	});
	await peer?.destroy();
	await observePeer("recreated", async () => {
		peer = await createJsPeer("recreated");
	});
	await peer?.destroy();
	await observePeer("isolated", () => createJsPeer("isolated"));
	check(
		localStorage.getItem(key) === sentinel,
		"Independent store modified the original store",
	);
	qaLog("webview-storage", {
		proof,
		result: "passed",
		observations,
		origin: location.origin,
		limitations:
			"Dure initial, JS/native secondary and recreated WebViews. The client separately verifies native-process restart persistence; Dure service/runtime restart is not exercised here.",
	});
}

void run().catch(async (error) => {
	const message = error instanceof Error ? error.message : String(error);
	if (processPhase) {
		await reportWindowFocusQa({
			proof,
			processPhase,
			result: "failed",
			error: message,
		});
	} else if (getCurrentWebviewWindow().label !== "main") {
		await emitTo("main", event, {
			proof,
			role,
			identifier: null,
			error: message,
		} satisfies Observation);
	} else {
		qaLog("webview-storage", { proof, result: "failed", error: message });
	}
});
