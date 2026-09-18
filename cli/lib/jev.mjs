// TypeSafe's stateless decision API. Shared by the CLI and MCP transport;
// this module neither selects agents nor changes a Session or Dispatch.
// Wire contract: https://docs.typesafe.ai/api (reviewed 2026-09-18).
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_REQUEST_BYTES = 512 * 1024;
const RESPONSE_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 15_000;

const contentSchema = { type: ["string", "object", "array"] };
const questionSchema = (type, criteria, required = true) => ({
  type: "object",
  required: ["type", "instructions", ...(required ? ["criteria"] : [])],
  properties: { type: { const: type }, instructions: contentSchema, criteria },
  additionalProperties: false,
});

export const jevInputSchema = {
  type: "object",
  required: ["state", "questions"],
  properties: {
    state: contentSchema,
    model: { type: "string", minLength: 1, maxLength: 128, default: JEV_DEFAULT_MODEL },
    questions: {
      type: "object",
      minProperties: 1,
      additionalProperties: {
        oneOf: [
          questionSchema(
            "noul",
            {
              type: "object",
              properties: { true: { type: "string" }, false: { type: "string" } },
              additionalProperties: false,
            },
            false,
          ),
          questionSchema("choice", {
            type: "object",
            minProperties: 2,
            maxProperties: 255,
            additionalProperties: { type: ["string", "null"] },
          }),
          questionSchema("score", {
            type: "array",
            minItems: 2,
            maxItems: 10,
            items: { type: "string" },
          }),
        ],
      },
    },
  },
  additionalProperties: false,
};

export class JevError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const content = (value) => typeof value === "string" || record(value) || Array.isArray(value);
const probability = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const keysAllowed = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const sameKeys = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

function invalidRequest() {
  throw new JevError(
    "jev_invalid_request",
    "Provide state and named noul, choice, or score questions. See dure jev --help.",
  );
}

function requestBody(input) {
  if (
    !record(input) ||
    !keysAllowed(input, ["state", "model", "questions"]) ||
    !content(input.state)
  )
    invalidRequest();
  const model = input.model === undefined ? JEV_DEFAULT_MODEL : input.model;
  if (typeof model !== "string" || !model.trim() || model.length > 128) invalidRequest();
  if (!record(input.questions) || Object.keys(input.questions).length === 0) invalidRequest();
  for (const question of Object.values(input.questions)) {
    if (
      !record(question) ||
      !keysAllowed(question, ["type", "instructions", "criteria"]) ||
      !content(question.instructions)
    )
      invalidRequest();
    const criteria = question.criteria;
    switch (question.type) {
      case "noul":
        if (
          criteria !== undefined &&
          (!record(criteria) ||
            !keysAllowed(criteria, ["true", "false"]) ||
            !Object.values(criteria).every((value) => typeof value === "string"))
        )
          invalidRequest();
        break;
      case "choice":
        if (
          !record(criteria) ||
          Object.keys(criteria).length < 2 ||
          Object.keys(criteria).length > 255 ||
          !Object.values(criteria).every((value) => value === null || typeof value === "string")
        )
          invalidRequest();
        break;
      case "score":
        if (
          !Array.isArray(criteria) ||
          criteria.length < 2 ||
          criteria.length > 10 ||
          !criteria.every((value) => typeof value === "string")
        )
          invalidRequest();
        break;
      default:
        invalidRequest();
    }
  }
  let body;
  try {
    body = JSON.stringify({ state: input.state, model, questions: input.questions });
  } catch {
    invalidRequest();
  }
  if (Buffer.byteLength(body) > JEV_REQUEST_BYTES) {
    throw new JevError(
      "jev_request_too_large",
      "Jev requests must be at most 512 KiB. Reduce the supplied state or questions.",
    );
  }
  return body;
}

function invalidResponse() {
  throw new JevError(
    "jev_invalid_response",
    "TypeSafe returned an invalid or incomplete Jev response.",
  );
}

function distribution(value, keys) {
  if (!sameKeys(value, keys) || !Object.values(value).every(probability)) invalidResponse();
  // Permit small rounding differences without renormalizing provider evidence.
  if (Math.abs(Object.values(value).reduce((sum, item) => sum + item, 0) - 1) > 0.001)
    invalidResponse();
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function evaluationReceipt(response, questions) {
  if (
    !record(response) ||
    typeof response.model !== "string" ||
    !response.model.trim() ||
    response.model.length > 128 ||
    !sameKeys(response.answers, Object.keys(questions))
  )
    invalidResponse();
  if (
    !record(response.usage) ||
    ![response.usage.input_tokens, response.usage.output_tokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    invalidResponse();
  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const answer = response.answers[id];
      if (!record(answer) || answer.type !== question.type) invalidResponse();
      if (answer.type === "noul") {
        if (!probability(answer.noul)) invalidResponse();
        return [id, { type: "noul", noul: answer.noul }];
      }
      if (!probability(answer.confidence)) invalidResponse();
      if (answer.type === "choice") {
        if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice))
          invalidResponse();
        return [
          id,
          {
            type: "choice",
            choice: answer.choice,
            probabilities: distribution(answer.probabilities, Object.keys(question.criteria)),
            confidence: answer.confidence,
          },
        ];
      }
      const levels = question.criteria.map((_, index) => String(index));
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > levels.length - 1 ||
        !sameKeys(answer.legend, levels) ||
        !levels.every((level) => answer.legend[level] === question.criteria[Number(level)])
      )
        invalidResponse();
      return [
        id,
        {
          type: "score",
          score: answer.score,
          legend: Object.fromEntries(levels.map((level) => [level, answer.legend[level]])),
          probabilities: distribution(answer.probabilities, levels),
          confidence: answer.confidence,
        },
      ];
    }),
  );
  return {
    schemaVersion: 1,
    kind: "dure.jev.evaluation",
    model: response.model,
    answers,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}

async function readResponse(response) {
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_BYTES) invalidResponse();
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      invalidResponse();
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpError(status) {
  const errors = {
    401: ["jev_authentication_failed", "TypeSafe rejected TYPESAFE_API_KEY."],
    403: ["jev_access_denied", "The TypeSafe account does not have access to this evaluation."],
    422: [
      "jev_request_rejected",
      "TypeSafe rejected the request. Check the model, question definitions, and token budget.",
    ],
    429: ["jev_rate_limited", "TypeSafe rate limit reached. Wait before trying again."],
    529: ["jev_overloaded", "TypeSafe is temporarily overloaded. Wait before trying again."],
  };
  const [code, message] = errors[status] ?? [
    "jev_http_error",
    "TypeSafe could not complete the evaluation.",
  ];
  return new JevError(code, message, status);
}

/** Only explicit input leaves the process. No file discovery, implicit context,
 * redirects, or retries; even a timed-out request may have consumed tokens. */
export async function evaluateJev(
  input,
  { environment = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEADLINE_MS } = {},
) {
  const body = requestBody(input);
  const key = environment.TYPESAFE_API_KEY?.trim();
  if (!key)
    throw new JevError(
      "jev_api_key_missing",
      "Set TYPESAFE_API_KEY in the environment of the Dure CLI or MCP server.",
    );
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new JevError(
          "jev_timeout",
          "Jev evaluation timed out. The request was not retried and may have consumed tokens.",
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetchImpl(JEV_ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw httpError(response.status);
        }
        return evaluationReceipt(await readResponse(response), JSON.parse(body).questions);
      })(),
    ]);
  } catch (error) {
    if (error instanceof JevError) throw error;
    throw new JevError(
      "jev_transport_failed",
      "Could not reach TypeSafe. The request was not retried.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export function jevErrorReport(error) {
  const failure =
    error instanceof JevError ? error : new JevError("jev_failed", "Jev evaluation failed.");
  return {
    schemaVersion: 1,
    kind: "dure.jev.error",
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.status === undefined ? {} : { status: failure.status }),
    },
  };
}
