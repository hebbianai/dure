function contractError(reason) {
	const error = new Error(`dure_claude_driver_${reason}`);
	error.code = "DURE_CLAUDE_DRIVER_CONTRACT";
	return error;
}

function parseRuntime(runtime) {
	if (
		!runtime ||
		typeof runtime !== "object" ||
		!Number.isSafeInteger(runtime.child?.pid) ||
		runtime.child.pid <= 1 ||
		typeof runtime.completion?.then !== "function"
	) {
		throw contractError("invalid_runtime");
	}
	return runtime;
}

function parseCompletion(result) {
	if (!result || typeof result !== "object") {
		throw contractError("invalid_completion");
	}
	const { code, signal } = result;
	if (
		(code !== null && (!Number.isSafeInteger(code) || code < 0)) ||
		(signal !== null && typeof signal !== "string")
	) {
		throw contractError("invalid_completion");
	}
	return { code, signal };
}

export async function runSingleClaudeRuntime({ launch } = {}) {
	if (typeof launch !== "function") {
		throw contractError("launch_required");
	}

	// A driver generation owns exactly one provider root. Hmux owns destructive
	// cleanup for the whole process session, so this layer only launches once and
	// observes that root until it exits.
	const runtime = parseRuntime(await launch());
	return parseCompletion(await runtime.completion);
}
