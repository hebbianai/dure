import fs from "node:fs";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const deadline = Date.now() + 180_000;
const logPath = resolveQaLogPath();

while (Date.now() < deadline) {
	if (fs.existsSync(logPath)) {
		const lines = fs.readFileSync(logPath, "utf8").split("\n");
		for (const line of lines) {
			const payloadStart = line.indexOf("] ");
			if (payloadStart < 0) continue;
			let payload;
			try {
				payload = JSON.parse(line.slice(payloadStart + 2));
			} catch {
				continue;
			}
			if (!Array.isArray(payload) || payload[0] !== "imepreedit") continue;
			const result = payload[1];
			const point = (snapshot) =>
				snapshot
					? {
							cursor: snapshot.cursor,
							input: snapshot.input,
							overlay: snapshot.overlay,
							presentationRight: snapshot.presentationRight,
						}
					: null;
			const report = {
				schemaVersion: result?.schemaVersion,
				pass: result?.pass,
				userAgent: result?.userAgent,
				replacementPending: point(result?.replacementPending),
				replacementCommitted: point(result?.replacementCommitted),
				rapidPreedit: point(result?.rapidPreedit),
				koreanCommitted: point(result?.koreanCommitted),
				japanesePreedit: point(result?.japanesePreedit),
				genericPreedit: point(result?.genericPreedit),
				bounded: point(result?.bounded),
				cancelled: point(result?.cancelled),
				interruptedBackspace: point(result?.interruptedBackspace),
				interruptedRecovered: point(result?.interruptedRecovered),
				clickRecovered: point(result?.clickRecovered),
				selectionRecovered: point(result?.selectionRecovered),
				eventTrace: result?.eventTrace,
				errors: result?.errors,
			};
			console.log(JSON.stringify(report, null, 2));
			if (result?.schemaVersion !== 1 || result.pass !== true) {
				throw new Error(
					`isolated WKWebView IME preedit evidence failed: ${JSON.stringify(result?.errors ?? report)}`,
				);
			}
			console.log("isolated WKWebView IME preedit evidence: PASS");
			process.exit(0);
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 100));
}

throw new Error("timed out waiting for isolated WKWebView IME preedit evidence");
