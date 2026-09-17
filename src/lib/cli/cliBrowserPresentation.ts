import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	parseBrowserPresentationRequest,
	presentBrowserPage,
} from "@/lib/browser/browserPresentation";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";

const dependencies = {
	windowLabel: () => getCurrentWebviewWindow().label,
	claim: claimCliRequest,
	present: presentBrowserPage,
};

function failed(error: unknown) {
	return {
		ok: false,
		error: {
			code:
				error &&
				typeof error === "object" &&
				"code" in error &&
				typeof error.code === "string"
					? error.code
					: "browser_presentation_failed",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

/** Only the explicitly selected window may claim this presentation request. */
export async function handleCliBrowserPresentation(
	params: unknown,
	reqId: string,
	runtime = dependencies,
) {
	let request: ReturnType<typeof parseBrowserPresentationRequest>;
	try {
		request = parseBrowserPresentationRequest(params);
	} catch (error) {
		if (runtime.windowLabel() !== "main" || !(await runtime.claim(reqId)))
			return null;
		return failed(error);
	}
	if (
		runtime.windowLabel() !== request.windowLabel ||
		!(await runtime.claim(reqId))
	)
		return null;
	try {
		return { ok: true, presentation: await runtime.present(request) };
	} catch (error) {
		return failed(error);
	}
}
