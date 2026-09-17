import { createHash } from "node:crypto";

const MAX_ANSWER_BYTES = 8 * 1024;
const MAX_COLLECTION_ENTRIES = 256;
const MAX_INTERACTION_INPUT_BYTES = 8 * 1024;
const MAX_INTERACTION_REQUEST_BYTES = 16 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_PENDING_INTERACTIONS = 12;
const MAX_STRING_BYTES = 8 * 1024;
const SAFE_REASON = /^[a-z0-9_]{1,64}$/u;

function interactionError(reason) {
	const error = new Error(`dure_claude_agent_sdk_${reason}`);
	error.code = "DURE_CLAUDE_AGENT_SDK_CONTRACT";
	return error;
}

function plainObject(value, reason) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw interactionError(reason);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw interactionError(reason);
	}
	return value;
}

function boundedString(value, reason, { allowEmpty = true, nullable = false } = {}) {
	if (nullable && (value === null || value === undefined)) return null;
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES
	) {
		throw interactionError(reason);
	}
	return value;
}

function normalizeJson(value, reason, depth = 0) {
	if (depth > MAX_JSON_DEPTH) throw interactionError(reason);
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw interactionError(reason);
		return value;
	}
	if (typeof value === "string") return boundedString(value, reason);
	if (Array.isArray(value)) {
		if (value.length > MAX_COLLECTION_ENTRIES) throw interactionError(reason);
		return value.map((entry) => normalizeJson(entry, reason, depth + 1));
	}
	plainObject(value, reason);
	const entries = Object.entries(value);
	if (entries.length > MAX_COLLECTION_ENTRIES) throw interactionError(reason);
	const normalized = {};
	for (const [key, entry] of entries) {
		boundedString(key, reason, { allowEmpty: false });
		Object.defineProperty(normalized, key, {
			configurable: true,
			enumerable: true,
			value: normalizeJson(entry, reason, depth + 1),
			writable: true,
		});
	}
	return normalized;
}

function boundedJsonObject(value, reason, maxBytes) {
	const normalized = normalizeJson(plainObject(value, reason), reason);
	if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > maxBytes) {
		throw interactionError(reason);
	}
	return normalized;
}

function clone(value) {
	return structuredClone(value);
}

function deferred() {
	let reject;
	let resolve;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		reject = rejectPromise;
		resolve = resolvePromise;
	});
	return { promise, reject, resolve };
}

function privateRequestId(identity, sdkRequestId) {
	const digest = createHash("sha256")
		.update(identity.runtimeGeneration, "utf8")
		.update("\0", "utf8")
		.update(identity.queryEpoch, "utf8")
		.update("\0", "utf8")
		.update(sdkRequestId, "utf8")
		.digest("hex");
	return `interaction-${digest}`;
}

function questionTexts(input) {
	if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 16) {
		throw interactionError("question_input_invalid");
	}
	const texts = input.questions.map((rawQuestion) => {
		const question = plainObject(rawQuestion, "question_input_invalid");
		return boundedString(question.question, "question_input_invalid", { allowEmpty: false });
	});
	if (new Set(texts).size !== texts.length) {
		throw interactionError("question_input_invalid");
	}
	return Object.freeze(texts);
}

function questionRequestInput(input) {
	return {
		...clone(input),
		questions: input.questions.map((question) => ({ ...clone(question), allowOther: true })),
	};
}

function questionAnswers(value, expectedQuestions) {
	const rawAnswers = plainObject(value, "question_answer_invalid");
	const entries = Object.entries(rawAnswers);
	if (entries.length < 1 || entries.length > expectedQuestions.length) {
		throw interactionError("question_answer_invalid");
	}
	const expected = new Set(expectedQuestions);
	const answers = {};
	for (const [question, rawAnswer] of entries) {
		if (!expected.has(question)) throw interactionError("question_answer_invalid");
		Object.defineProperty(answers, question, {
			configurable: true,
			enumerable: true,
			value: boundedString(rawAnswer, "question_answer_invalid", {
				allowEmpty: false,
			}),
			writable: true,
		});
	}
	if (Buffer.byteLength(JSON.stringify(answers), "utf8") > MAX_ANSWER_BYTES) {
		throw interactionError("question_answer_invalid");
	}
	return answers;
}

function permissionResult(answer) {
	if (answer.decision === "allow") {
		return { outcome: "allowed", sdkResult: Object.freeze({ behavior: "allow" }) };
	}
	if (answer.decision !== "deny") throw interactionError("permission_answer_invalid");
	const message =
		answer.message === undefined
			? "Denied by user"
			: boundedString(answer.message, "permission_answer_invalid", { allowEmpty: false });
	if (answer.interrupt !== undefined && typeof answer.interrupt !== "boolean") {
		throw interactionError("permission_answer_invalid");
	}
	return {
		outcome: "denied",
		sdkResult: Object.freeze({
			behavior: "deny",
			...(answer.interrupt === undefined ? {} : { interrupt: answer.interrupt }),
			message,
		}),
	};
}

function questionResult(answer, entry) {
	if (answer.decision === "deny") return permissionResult(answer);
	if (answer.decision !== undefined) throw interactionError("question_answer_invalid");
	const answers = questionAnswers(answer.answers, entry.questionTexts);
	return {
		outcome: "answered",
		sdkResult: Object.freeze({
			behavior: "allow",
			updatedInput: Object.freeze({ ...clone(entry.input), answers }),
		}),
	};
}

export function createClaudeQueryInteractionBroker({ activeTurn, emit, identity } = {}) {
	if (typeof activeTurn !== "function" || typeof emit !== "function") {
		throw interactionError("interaction_broker_callbacks_invalid");
	}
	plainObject(identity, "interaction_broker_identity_invalid");
	boundedString(identity.runtimeGeneration, "interaction_broker_identity_invalid", {
		allowEmpty: false,
	});
	boundedString(identity.queryEpoch, "interaction_broker_identity_invalid", {
		allowEmpty: false,
	});

	const pending = new Map();

	const remove = (entry) => {
		if (pending.get(entry.request.requestId) !== entry) return false;
		pending.delete(entry.request.requestId);
		entry.signal.removeEventListener("abort", entry.onAbort);
		return true;
	};

	const cancel = (entry, reason, emitEvent) => {
		if (!remove(entry)) return false;
		if (emitEvent) {
			try {
				emit("interaction_cancelled", {
					clientMessageId: entry.request.clientMessageId,
					kind: entry.request.kind,
					reason,
					requestId: entry.request.requestId,
				});
			} catch {
				// Resolver cleanup remains mandatory after its Query authority disappears.
			}
		}
		entry.completion.reject(interactionError("interaction_cancelled"));
		return true;
	};

	return Object.freeze({
		async answerInteraction(rawAnswer) {
			const answer = plainObject(rawAnswer, "interaction_answer_invalid");
			const requestId = boundedString(answer.requestId, "interaction_answer_invalid", {
				allowEmpty: false,
			});
			const entry = pending.get(requestId);
			if (!entry) throw interactionError("interaction_stale");
			if (
				answer.clientMessageId !== entry.request.clientMessageId ||
				answer.kind !== entry.request.kind
			) {
				throw interactionError("interaction_identity_mismatch");
			}
			const result =
				entry.request.kind === "question"
					? questionResult(answer, entry)
					: permissionResult(answer);
			if (!remove(entry)) throw interactionError("interaction_stale");
			const receipt = Object.freeze({
				clientMessageId: entry.request.clientMessageId,
				kind: entry.request.kind,
				outcome: result.outcome,
				requestId,
			});
			try {
				emit("interaction_resolved", receipt);
			} catch (error) {
				entry.completion.reject(error);
				throw error;
			}
			entry.completion.resolve(result.sdkResult);
			return receipt;
		},

		cancelAll(reason, { emitEvents = true } = {}) {
			if (typeof reason !== "string" || !SAFE_REASON.test(reason)) {
				throw interactionError("interaction_cancel_reason_invalid");
			}
			let count = 0;
			for (const entry of [...pending.values()]) {
				if (cancel(entry, reason, emitEvents)) count += 1;
			}
			return count;
		},

		async canUseTool(toolName, rawInput, options) {
			toolName = boundedString(toolName, "interaction_tool_name_invalid", {
				allowEmpty: false,
			});
			options = plainObject(options, "interaction_options_invalid");
			if (!options.signal || typeof options.signal.addEventListener !== "function") {
				throw interactionError("interaction_signal_invalid");
			}
			if (pending.size >= MAX_PENDING_INTERACTIONS) {
				throw interactionError("interaction_capacity_exceeded");
			}
			const turn = activeTurn();
			if (!turn) throw interactionError("interaction_without_turn");
			const clientMessageId = boundedString(
				turn.clientMessageId,
				"interaction_turn_identity_invalid",
				{ allowEmpty: false },
			);
			const sdkRequestId = boundedString(options.requestId, "interaction_request_id_invalid", {
				allowEmpty: false,
			});
			const requestId = privateRequestId(identity, sdkRequestId);
			if (pending.has(requestId)) throw interactionError("interaction_request_conflict");
			const input = boundedJsonObject(
				rawInput,
				"interaction_input_invalid",
				MAX_INTERACTION_INPUT_BYTES,
			);
			const kind = toolName === "AskUserQuestion" ? "question" : "permission";
			const expectedQuestionTexts = kind === "question" ? questionTexts(input) : undefined;
			const requestInput = kind === "question" ? questionRequestInput(input) : input;
			const suggestions =
				options.suggestions === undefined
					? Object.freeze([])
					: normalizeJson(options.suggestions, "interaction_suggestions_invalid");
			if (!Array.isArray(suggestions)) {
				throw interactionError("interaction_suggestions_invalid");
			}
			const request = Object.freeze({
				agentId: boundedString(options.agentID, "interaction_agent_id_invalid", {
					nullable: true,
				}),
				clientMessageId,
				input: requestInput,
				kind,
				matchedAskRule:
					options.matchedAskRule === undefined
						? null
						: boundedJsonObject(
								options.matchedAskRule,
								"interaction_matched_ask_rule_invalid",
								MAX_INTERACTION_INPUT_BYTES,
							),
				presentation: Object.freeze({
					blockedPath: boundedString(
						options.blockedPath,
						"interaction_presentation_invalid",
						{ nullable: true },
					),
					decisionReason: boundedString(
						options.decisionReason,
						"interaction_presentation_invalid",
						{ nullable: true },
					),
					description: boundedString(
						options.description,
						"interaction_presentation_invalid",
						{ nullable: true },
					),
					displayName: boundedString(
						options.displayName,
						"interaction_presentation_invalid",
						{ nullable: true },
					),
					title: boundedString(options.title, "interaction_presentation_invalid", {
						nullable: true,
					}),
				}),
				requestId,
				suggestions,
				toolName,
				toolUseId: boundedString(options.toolUseID, "interaction_tool_use_id_invalid", {
					allowEmpty: false,
				}),
			});
			if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_INTERACTION_REQUEST_BYTES) {
				throw interactionError("interaction_request_too_large");
			}
			const completion = deferred();
			const entry = {
				completion,
				input,
				onAbort: undefined,
				questionTexts: expectedQuestionTexts,
				request,
				signal: options.signal,
			};
			entry.onAbort = () => cancel(entry, "sdk_cancelled", true);
			pending.set(requestId, entry);
			options.signal.addEventListener("abort", entry.onAbort, { once: true });
			if (options.signal.aborted) entry.onAbort();
			if (!pending.has(requestId)) return completion.promise;
			try {
				emit("interaction_requested", clone(request));
			} catch (error) {
				remove(entry);
				completion.reject(error);
			}
			return completion.promise;
		},

		pendingInteractions() {
			return Object.freeze([...pending.values()].map(({ request }) => clone(request)));
		},

		pendingInteractionCount() {
			return pending.size;
		},
	});
}
