import type { WebviewDiagnosticInput } from "@/lib/ipc/webviewDiagnostics";

import { WEBVIEW_DIAGNOSTIC_CODES } from "../../../cli/lib/contracts/webview-diagnostics.mjs";

const FAILURE_CODES = new Set<WebviewDiagnosticInput["code"]>(
	WEBVIEW_DIAGNOSTIC_CODES,
);
const BOUNDARIES = new Set([
	"[boundary:app]",
	"[boundary:diff-window]",
	"[boundary:session-window]",
	"[boundary:source-control-window]",
	"[boundary:popout-window]",
]);

// Do not stringify console values, traverse objects, call getters, or retain
// text. Even apparently harmless strings can contain private conversations.
function knownCode(value: unknown): WebviewDiagnosticInput["code"] {
	try {
		if (typeof value === "object" && value !== null) {
			for (const key of ["code", "message"]) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (
					descriptor &&
					"value" in descriptor &&
					typeof descriptor.value === "string"
				) {
					const code = knownCode(descriptor.value);
					if (code !== "redacted") return code;
				}
			}
		} else if (typeof value === "string") {
			const code = value.slice(0, 128).split(/[\s:]/, 1)[0];
			if (FAILURE_CODES.has(code as WebviewDiagnosticInput["code"]))
				return code as WebviewDiagnosticInput["code"];
		}
	} catch {
		// Hostile proxies must not break the original console call.
	}
	return "redacted";
}

export function classifyWebviewDiagnostic(
	level: WebviewDiagnosticInput["level"],
	source: WebviewDiagnosticInput["source"],
	args: readonly unknown[],
): WebviewDiagnosticInput {
	const first = args[0];
	if (source === "console" && typeof first === "string" && first.length <= 64) {
		if (BOUNDARIES.has(first)) source = "render_boundary";
		else if (first === "[main] entry import failed") source = "entry_import";
	}
	let code: WebviewDiagnosticInput["code"] = "redacted";
	for (let index = 0; index < Math.min(4, args.length); index++) {
		code = knownCode(args[index]);
		if (code !== "redacted") break;
	}
	return { level, source, code };
}

/** One bounded queue/in-flight request per realm; failure disables this sink.
 * Unknown/older native commands and disk errors must never form an error loop.
 */
export function installWebviewDiagnostics(
	target: Pick<Window, "addEventListener" | "removeEventListener">,
	consoleTarget: Pick<Console, "warn" | "error">,
	persist: (events: WebviewDiagnosticInput[]) => Promise<unknown>,
) {
	let pending: WebviewDiagnosticInput[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight = false;
	let stopped = false;
	let capturing = false;
	let remaining = 32;
	let intervalStart = performance.now();
	const originals = { warn: consoleTarget.warn, error: consoleTarget.error };
	async function flush() {
		if (stopped || inFlight || pending.length === 0) return;
		inFlight = true;
		const batch = pending.splice(0, 16);
		try {
			await persist(batch);
		} catch {
			stopped = true;
			pending = [];
		} finally {
			inFlight = false;
			schedule();
		}
	}
	function schedule() {
		if (stopped || timer || inFlight || pending.length === 0) return;
		timer = setTimeout(() => {
			timer = undefined;
			void flush();
		}, 1_000);
	}
	function capture(
		level: WebviewDiagnosticInput["level"],
		source: WebviewDiagnosticInput["source"],
		args: readonly unknown[],
	) {
		if (stopped || capturing) return;
		const now = performance.now();
		if (now - intervalStart >= 10_000) {
			remaining = 32;
			intervalStart = now;
		}
		if (remaining === 0 || pending.length >= 32) return;
		remaining--;
		capturing = true;
		try {
			pending.push(classifyWebviewDiagnostic(level, source, args));
			schedule();
		} finally {
			capturing = false;
		}
	}
	const wrappers = {
		warn: (...args: unknown[]) => {
			capture("warn", "console", args);
			originals.warn.apply(consoleTarget, args);
		},
		error: (...args: unknown[]) => {
			capture("error", "console", args);
			originals.error.apply(consoleTarget, args);
		},
	};
	consoleTarget.warn = wrappers.warn;
	consoleTarget.error = wrappers.error;
	const error = (event: ErrorEvent) =>
		capture("error", "window_error", [event.error]);
	const rejection = (event: PromiseRejectionEvent) =>
		capture("error", "unhandled_rejection", [event.reason]);
	const pagehide = () => {
		clearTimeout(timer);
		timer = undefined;
		void flush();
	};
	target.addEventListener("pagehide", pagehide);
	target.addEventListener("error", error);
	target.addEventListener("unhandledrejection", rejection);
	return () => {
		stopped = true;
		pending = [];
		clearTimeout(timer);
		target.removeEventListener("pagehide", pagehide);
		target.removeEventListener("error", error);
		target.removeEventListener("unhandledrejection", rejection);
		if (consoleTarget.warn === wrappers.warn)
			consoleTarget.warn = originals.warn;
		if (consoleTarget.error === wrappers.error)
			consoleTarget.error = originals.error;
	};
}
