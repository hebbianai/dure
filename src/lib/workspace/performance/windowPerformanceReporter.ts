import { emitTo } from "@tauri-apps/api/event";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { installWindowEventLoopLagMonitor } from "./windowEventLoopLag";
import { readWindowPerformanceDiagnostics } from "./windowPerformanceDiagnostics";
import {
	parseWindowReportRequest,
	WINDOW_REPORT_REQUEST_EVENT,
	WINDOW_REPORT_RESPONSE_EVENT,
} from "./windowReportCollection";
import { readWindowTerminalInputDiagnostics } from "./windowTerminalInputDiagnostics";

export async function installWindowPerformanceReporter(): Promise<() => void> {
	const stopLagMonitor = installWindowEventLoopLagMonitor();
	let unlisten: () => void;
	try {
		unlisten = await listenWhenReady<unknown>(
			WINDOW_REPORT_REQUEST_EVENT,
			(event) => {
				const request = parseWindowReportRequest(event.payload);
				if (!request) return;
				const readLocal =
					request.projection === "terminal-input"
						? readWindowTerminalInputDiagnostics
						: readWindowPerformanceDiagnostics;
				void readLocal()
					.then((sample) =>
						emitTo(
							{
								kind: "WebviewWindow",
								label: request.replyWindowLabel,
							},
							WINDOW_REPORT_RESPONSE_EVENT,
							{
								requestId: request.requestId,
								...(request.projection
									? { projection: request.projection }
									: {}),
								sample,
							},
						),
					)
					.catch(() => undefined);
			},
		);
	} catch (error) {
		stopLagMonitor();
		throw error;
	}
	return () => {
		unlisten();
		stopLagMonitor();
	};
}
