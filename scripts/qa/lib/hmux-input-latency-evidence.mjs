const OUTCOME_COUNT_FIELDS = [
	"completedCount",
	"correlationSupersededCount",
	"failedCount",
	"timedOutCount",
	"timedOutAfterSuccessorOutputCount",
	"timedOutWithoutSuccessorCount",
];

const COMPLETE_TRACE_FIELDS = [
	"dispatchMs",
	"captureToSemanticHandlerMs",
	"semanticHandlerToDispatchMs",
	"semanticHandlerToDecisionMs",
	"semanticDecisionToDispatchMs",
	"transportConfirmationMs",
	"hostReceiptMs",
	"hostInputAcceptedToOutputMs",
	"hostOutputToProjectionStartMs",
	"outputReceivedMs",
	"projectionStartedMs",
	"projectionCommittedMs",
	"echoTaskMs",
	"echoFrameMs",
	"echoPaintMs",
	"receiptToOutputMs",
	"outputToPaintMs",
	"receiptToPaintMs",
];

export function assertDirectInputEvidence(before, after, labels) {
	const beforeTarget = inputDiagnostics(before, labels.target);
	const afterTarget = inputDiagnostics(after, labels.target);
	const beforeSibling = inputDiagnostics(before, labels.sibling);
	const afterSibling = inputDiagnostics(after, labels.sibling);
	assertSourceUnchanged(beforeTarget, afterTarget, "keydown", labels.target);
	assertSourceUnchanged(beforeTarget, afterTarget, "input", labels.target);
	assertSourceUnchanged(beforeSibling, afterSibling, "keydown", labels.sibling);

	const inputDelta = sourceCountDelta(
		beforeSibling,
		afterSibling,
		"input",
	);
	if (inputDelta.completedCount < 1) {
		throw new Error("direct Hmux input produced no completed source=input trace");
	}
	assertNoFailureDelta(inputDelta, "direct Hmux source=input");
	return { completedInputSamples: inputDelta.completedCount };
}

export function completedKeydownDelta(before, after, windowLabel) {
	return sourceCountDelta(
		inputDiagnostics(before, windowLabel),
		inputDiagnostics(after, windowLabel),
		"keydown",
	).completedCount;
}

export function assertNativeKeydownEvidence(before, after, labels) {
	const beforeTarget = inputDiagnostics(before, labels.target);
	const afterTarget = inputDiagnostics(after, labels.target);
	const beforeSibling = inputDiagnostics(before, labels.sibling);
	const afterSibling = inputDiagnostics(after, labels.sibling);
	const keydownDelta = sourceCountDelta(
		beforeTarget,
		afterTarget,
		"keydown",
	);
	if (keydownDelta.completedCount !== 1) {
		throw new Error(
			`native input completed ${keydownDelta.completedCount} source=keydown traces; expected exactly one`,
		);
	}
	assertNoFailureDelta(keydownDelta, "native source=keydown");
	assertSourceUnchanged(beforeTarget, afterTarget, "input", labels.target);
	assertSourceUnchanged(beforeSibling, afterSibling, "keydown", labels.sibling);
	assertSourceUnchanged(beforeSibling, afterSibling, "input", labels.sibling);
	if (afterTarget.inFlightCount !== 0 || afterSibling.inFlightCount !== 0) {
		throw new Error("native input trace did not settle before evidence capture");
	}

	const priorSequences = new Set(
		beforeTarget.recent
			.filter((sample) => sample.source === "keydown")
			.map((sample) => sample.sequence),
	);
	const samples = afterTarget.recent.filter(
		(sample) =>
			sample.source === "keydown" && !priorSequences.has(sample.sequence),
	);
	if (samples.length !== 1) {
		throw new Error(
			`native input exposed ${samples.length} new source=keydown samples; expected exactly one`,
		);
	}
	assertCompleteKeydownTrace(samples[0]);
	return samples[0];
}

export function captureFocusedWindowFence(status, targetRole = "a") {
	const siblingRole = targetRole === "a" ? "b" : "a";
	const target = status?.windows?.[targetRole];
	const sibling = status?.windows?.[siblingRole];
	const targetNative = status?.nativeWindows?.[targetRole];
	const siblingNative = status?.nativeWindows?.[siblingRole];
	if (
		!target ||
		target.mounted !== true ||
		target.listening !== true ||
		target.synchronized !== true ||
		target.hydrating !== false ||
		target.documentFocused !== true ||
		target.terminalInputFocused !== true ||
		target.controlState !== "controlling" ||
		targetNative?.exists !== true ||
		targetNative.visible !== true ||
		targetNative.focused !== true ||
		sibling?.mounted !== true ||
		sibling.listening !== true ||
		sibling.synchronized !== true ||
		sibling.hydrating !== false ||
		sibling.documentFocused !== false ||
		siblingNative?.exists !== true ||
		siblingNative.visible !== true ||
		siblingNative?.focused !== false ||
		status?.controllerWindow?.exists !== true ||
		status.controllerWindow.visible !== false ||
		status?.controllerWindow?.focused !== false ||
		!nonEmptyString(target.webviewInstanceId) ||
		!nonEmptyString(target.webviewStartedAt) ||
		!nonEmptyString(target.latestSurfaceAttachmentId) ||
		target.latestRetiredSurfaceAttachmentId ===
			target.latestSurfaceAttachmentId
	) {
		throw new Error(
			`isolated native keydown focus fence is incomplete: ${JSON.stringify({ targetRole, status })}`,
		);
	}
	return {
		targetRole,
		webviewInstanceId: target.webviewInstanceId,
		webviewStartedAt: target.webviewStartedAt,
		attachmentId: target.latestSurfaceAttachmentId,
	};
}

export function assertFocusedWindowFence(fence, status) {
	const current = captureFocusedWindowFence(status, fence.targetRole);
	for (const field of [
		"webviewInstanceId",
		"webviewStartedAt",
		"attachmentId",
	]) {
		if (current[field] !== fence[field]) {
			throw new Error(`native keydown ${field} changed during measurement`);
		}
	}
}

export function captureAppGenerationFence({
	descriptor,
	ping,
	processGroupId,
	processIdentity,
}) {
	if (
		descriptor?.schemaVersion !== 1 ||
		ping?.ok !== true ||
		!positiveInteger(descriptor.processId) ||
		descriptor.processId !== ping.processId ||
		!positiveInteger(descriptor.startedAtUnixMs) ||
		descriptor.startedAtUnixMs !== ping.startedAtUnixMs ||
		!nonEmptyString(descriptor.generation) ||
		descriptor.generation !== ping.generation ||
		!nonEmptyString(descriptor.buildId) ||
		descriptor.buildId !== ping.buildId ||
		!nonEmptyString(descriptor.channel) ||
		descriptor.channel !== ping.channel ||
		!positiveInteger(processGroupId) ||
		!nonEmptyString(processIdentity)
	) {
		throw new Error("isolated app generation fence is incomplete");
	}
	return {
		processId: descriptor.processId,
		processGroupId,
		startedAtUnixMs: descriptor.startedAtUnixMs,
		generation: descriptor.generation,
		buildId: descriptor.buildId,
		channel: descriptor.channel,
		processIdentity,
	};
}

export function assertAppGenerationFence(
	fence,
	descriptor,
	ping,
	processIdentity,
) {
	const current = captureAppGenerationFence({
		descriptor,
		ping,
		processGroupId: fence.processGroupId,
		processIdentity,
	});
	for (const field of [
		"processId",
		"startedAtUnixMs",
		"generation",
		"buildId",
		"channel",
		"processIdentity",
	]) {
		if (current[field] !== fence[field]) {
			throw new Error(`isolated app ${field} changed during native keydown`);
		}
	}
}

function inputDiagnostics(receipt, windowLabel) {
	const multiWindow = receipt?.report;
	if (
		receipt?.ok !== true ||
		receipt.projection !== "terminal-input" ||
		multiWindow?.projection !== "terminal-input" ||
		multiWindow?.complete !== true ||
		!Array.isArray(multiWindow.windows) ||
		multiWindow.missingWindowLabels?.length !== 0
	) {
		throw new Error("multi-window terminal input report is incomplete");
	}
	const matches = multiWindow.windows.filter(
		(window) => window?.windowLabel === windowLabel,
	);
	if (matches.length !== 1 || !matches[0].terminalInput) {
		throw new Error(
			`terminal input report for ${windowLabel} is not exact`,
		);
	}
	return matches[0].terminalInput;
}

function sourceCounts(input, source) {
	const counts = input?.bySource?.[source];
	if (!counts) throw new Error(`terminal input source=${source} is missing`);
	return Object.fromEntries(
		OUTCOME_COUNT_FIELDS.map((field) => {
			const value = counts[field];
			if (!Number.isSafeInteger(value) || value < 0) {
				throw new Error(`terminal input source=${source} ${field} is invalid`);
			}
			return [field, value];
		}),
	);
}

function sourceCountDelta(before, after, source) {
	const beforeCounts = sourceCounts(before, source);
	const afterCounts = sourceCounts(after, source);
	return Object.fromEntries(
		OUTCOME_COUNT_FIELDS.map((field) => {
			const delta = afterCounts[field] - beforeCounts[field];
			if (delta < 0) {
				throw new Error(`terminal input source=${source} ${field} regressed`);
			}
			return [field, delta];
		}),
	);
}

function assertSourceUnchanged(before, after, source, windowLabel) {
	const delta = sourceCountDelta(before, after, source);
	if (OUTCOME_COUNT_FIELDS.some((field) => delta[field] !== 0)) {
		throw new Error(
			`${windowLabel} source=${source} changed unexpectedly: ${JSON.stringify(delta)}`,
		);
	}
}

function assertNoFailureDelta(delta, description) {
	for (const field of OUTCOME_COUNT_FIELDS.slice(1)) {
		if (delta[field] !== 0) {
			throw new Error(`${description} added ${field}: ${delta[field]}`);
		}
	}
}

function assertCompleteKeydownTrace(sample) {
	if (
		sample?.source !== "keydown" ||
		sample.outcome !== "complete" ||
		sample.successorOutputObserved !== true ||
		sample.replacementChainActiveAtCapture !== false ||
		typeof sample.hostReceiptBeforeTransportConfirmation !== "boolean" ||
		typeof sample.frameBeforeTask !== "boolean" ||
		!positiveInteger(sample.sequence) ||
		!nonEmptyString(sample.terminalId) ||
		(sample.desktopId !== null && !nonEmptyString(sample.desktopId)) ||
		!finiteNonNegative(sample.startedAt) ||
		COMPLETE_TRACE_FIELDS.some(
			(field) => !finiteNonNegative(sample[field]),
		)
	) {
		throw new Error(
			`native source=keydown trace is incomplete: ${JSON.stringify(sample)}`,
		);
	}
	if (
		sample.captureToSemanticHandlerMs > sample.dispatchMs ||
		sample.semanticHandlerToDecisionMs > sample.semanticHandlerToDispatchMs ||
		sample.semanticDecisionToDispatchMs > sample.semanticHandlerToDispatchMs ||
		sample.transportConfirmationMs < sample.dispatchMs ||
		sample.hostReceiptMs < sample.dispatchMs ||
		sample.hostReceiptBeforeTransportConfirmation !==
			(sample.hostReceiptMs < sample.transportConfirmationMs) ||
		!approximatelyEqual(
			sample.captureToSemanticHandlerMs +
				sample.semanticHandlerToDispatchMs,
			sample.dispatchMs,
		) ||
		!approximatelyEqual(
			sample.semanticHandlerToDecisionMs +
				sample.semanticDecisionToDispatchMs,
			sample.semanticHandlerToDispatchMs,
		) ||
		sample.projectionStartedMs < sample.outputReceivedMs ||
		sample.projectionCommittedMs < sample.projectionStartedMs ||
		sample.echoTaskMs < sample.projectionCommittedMs ||
		sample.echoFrameMs < sample.projectionCommittedMs ||
		(sample.frameBeforeTask && sample.echoFrameMs > sample.echoTaskMs) ||
		(!sample.frameBeforeTask && sample.echoTaskMs > sample.echoFrameMs) ||
		sample.echoPaintMs < sample.echoTaskMs ||
		sample.echoPaintMs < sample.echoFrameMs ||
		!approximatelyEqual(
			sample.receiptToOutputMs,
			Math.max(0, sample.outputReceivedMs - sample.hostReceiptMs),
		) ||
		!approximatelyEqual(
			sample.outputToPaintMs,
			Math.max(0, sample.echoPaintMs - sample.outputReceivedMs),
		) ||
		!approximatelyEqual(
			sample.receiptToPaintMs,
			Math.max(0, sample.echoPaintMs - sample.hostReceiptMs),
		)
	) {
		throw new Error(
			`native source=keydown trace is out of order: ${JSON.stringify(sample)}`,
		);
	}
}

function nonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}

function positiveInteger(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function finiteNonNegative(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function approximatelyEqual(left, right) {
	return Math.abs(left - right) <= 1e-6;
}
