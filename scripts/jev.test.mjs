import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateJev,
  JevError,
  JEV_ENDPOINT,
  JEV_REQUEST_BYTES,
  jevErrorReport,
} from "../cli/lib/jev.mjs";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";

const environment = { TYPESAFE_API_KEY: "fixture-key" };
const input = {
  state: { report: "The app crashes on launch.", testExitCode: 1 },
  questions: {
    bug: { type: "noul", instructions: "Does the report describe a bug?" },
    team: {
      type: "choice",
      instructions: "Which team should inspect it?",
      criteria: { desktop: "Desktop app", other: null },
    },
    impact: {
      type: "score",
      instructions: "How severe is the reported impact?",
      criteria: ["Cosmetic", "Feature impaired", "App unusable"],
    },
  },
};
const response = {
  model: "jev-1.13.0",
  answers: {
    bug: { type: "noul", noul: 0.95 },
    team: {
      type: "choice",
      choice: "desktop",
      probabilities: { desktop: 0.9, other: 0.1 },
      confidence: 0.8,
    },
    impact: {
      type: "score",
      score: 1.6,
      legend: { 0: "Cosmetic", 1: "Feature impaired", 2: "App unusable" },
      probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 },
      confidence: 0.78,
    },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
};
const reply = (body = response) => vi.fn(async () => Response.json(body));

afterEach(() => vi.useRealTimers());

describe("Jev evaluation", () => {
  it("sends one authenticated HTTP request and preserves all three answer types", async () => {
    const requests = [];
    const server = createServer(async (request, res) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await evaluateJev(input, {
        environment,
        fetchImpl: (url, options) => {
          expect(url).toBe(JEV_ENDPOINT);
          expect(options.redirect).toBe("error");
          return fetch(`http://127.0.0.1:${server.address().port}/v1/systemone`, options);
        },
      });
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/v1/systemone",
          authorization: "Bearer fixture-key",
          body: { ...input, model: "jev-latest" },
        },
      ]);
      expect(result).toEqual({ schemaVersion: 1, kind: "dure.jev.evaluation", ...response });
      expect(JSON.stringify(result)).not.toContain("fixture-key");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("honors a pinned model, structured instructions and independent question IDs", async () => {
    const fetchImpl = reply();
    await evaluateJev(
      {
        ...input,
        model: "jev-1.13.0",
        questions: {
          ...input.questions,
          bug: {
            type: "noul",
            instructions: ["Does this report a bug?"],
            criteria: { true: "Broken behavior" },
          },
        },
      },
      { environment, fetchImpl },
    );
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      model: "jev-1.13.0",
      questions: { bug: { instructions: ["Does this report a bug?"] } },
    });
  });

  it("does not truncate batched questions to an arbitrary small limit", async () => {
    const questions = Object.fromEntries(
      Array.from({ length: 218 }, (_, i) => [`q${i}`, input.questions.bug]),
    );
    const answers = Object.fromEntries(
      Object.keys(questions).map((id) => [id, response.answers.bug]),
    );
    const fetchImpl = reply({ ...response, answers });
    const result = await evaluateJev({ state: input.state, questions }, { environment, fetchImpl });
    expect(result.answers).toEqual(answers);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    {},
    { ...input, model: null },
    { ...input, state: false },
    { ...input, apiKey: "do-not-accept-keys-in-arguments" },
    { ...input, questions: {} },
    { ...input, questions: { bug: { type: "unknown", instructions: "?" } } },
    { ...input, questions: { bug: { type: "noul", instructions: null } } },
    { ...input, questions: { bug: { ...input.questions.bug, criteria: { yes: "yes" } } } },
    { ...input, questions: { bug: { ...input.questions.bug, confidence: 0.9 } } },
    {
      ...input,
      questions: { team: { ...input.questions.team, criteria: { one: "Only option" } } },
    },
    {
      ...input,
      questions: { team: { ...input.questions.team, criteria: { one: 42, two: null } } },
    },
    {
      ...input,
      questions: {
        team: {
          ...input.questions.team,
          criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p${i}`, null])),
        },
      },
    },
    { ...input, questions: { impact: { ...input.questions.impact, criteria: ["Only level"] } } },
    {
      ...input,
      questions: { impact: { ...input.questions.impact, criteria: Array(11).fill("Level") } },
    },
  ])("rejects malformed input before contacting TypeSafe (%#)", async (invalid) => {
    const fetchImpl = reply();
    await expect(evaluateJev(invalid, { environment, fetchImpl })).rejects.toMatchObject({
      code: "jev_invalid_request",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds request bytes, including multibyte state, before network I/O", async () => {
    const fetchImpl = reply();
    await expect(
      evaluateJev(
        { ...input, state: "한".repeat(JEV_REQUEST_BYTES / 2) },
        { environment, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "jev_request_too_large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails without a key before network I/O", async () => {
    const fetchImpl = reply();
    await expect(evaluateJev(input, { environment: {}, fetchImpl })).rejects.toMatchObject({
      code: "jev_api_key_missing",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [401, "jev_authentication_failed"],
    [403, "jev_access_denied"],
    [422, "jev_request_rejected"],
    [429, "jev_rate_limited"],
    [529, "jev_overloaded"],
    [500, "jev_http_error"],
    [302, "jev_http_error"],
  ])("reports HTTP %i without echoing the body or retrying", async (status, code) => {
    const fetchImpl = vi.fn(
      async () => new Response("fixture-key and private request", { status }),
    );
    const error = await evaluateJev(input, { environment, fetchImpl }).catch((error) => error);
    expect(jevErrorReport(error)).toMatchObject({ error: { code, status } });
    expect(JSON.stringify(jevErrorReport(error))).not.toMatch(/fixture-key|private request/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    (value) => {
      delete value.answers.bug;
    },
    (value) => {
      value.answers.extra = response.answers.bug;
    },
    (value) => {
      value.answers.bug.type = "score";
    },
    (value) => {
      value.answers.bug.noul = 1.01;
    },
    (value) => {
      value.answers.team.choice = "constructor";
    },
    (value) => {
      value.answers.team.confidence = -1;
    },
    (value) => {
      value.answers.team.probabilities.other = -0.1;
    },
    (value) => {
      value.answers.team.probabilities.other = 0.8;
    },
    (value) => {
      delete value.answers.team.probabilities.other;
    },
    (value) => {
      value.answers.impact.score = 3;
    },
    (value) => {
      value.answers.impact.legend["1"] = "Different rubric";
    },
    (value) => {
      value.usage.input_tokens = 1.5;
    },
    (value) => {
      value.model = "";
    },
  ])("rejects incomplete or mismatched provider evidence (%#)", async (change) => {
    const value = structuredClone(response);
    change(value);
    await expect(
      evaluateJev(input, { environment, fetchImpl: reply(value) }),
    ).rejects.toMatchObject({ code: "jev_invalid_response" });
  });

  it("preserves opaque IDs safely and omits unrecognized response fields", async () => {
    const questions = JSON.parse('{"__proto__":{"type":"noul","instructions":"Is this a bug?"}}');
    const answers = JSON.parse('{"__proto__":{"type":"noul","noul":0.8,"unexpected":"private"}}');
    const result = await evaluateJev(
      { state: "Crashes", questions },
      { environment, fetchImpl: reply({ ...response, answers, debug: "private" }) },
    );
    expect(Object.keys(result.answers)).toEqual(["__proto__"]);
    expect(result.answers.__proto__).toEqual({ type: "noul", noul: 0.8 });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype);
  });

  it.each(["not-json", "x".repeat(2 * 1024 * 1024 + 1)])(
    "rejects invalid or oversized response bodies (%#)",
    async (body) => {
      await expect(
        evaluateJev(input, { environment, fetchImpl: async () => new Response(body) }),
      ).rejects.toMatchObject({ code: "jev_invalid_response" });
    },
  );

  it.each(["headers", "body"])(
    "bounds time while awaiting %s and aborts without retrying",
    async (phase) => {
      vi.useFakeTimers();
      let signal;
      const fetchImpl = vi.fn((_url, options) => {
        signal = options.signal;
        return phase === "headers"
          ? new Promise(() => {})
          : Promise.resolve(new Response(new ReadableStream()));
      });
      const result = evaluateJev(input, { environment, fetchImpl, timeoutMs: 100 }).catch(
        (error) => error,
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ code: "jev_timeout" });
      expect(signal.aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("does not expose arbitrary transport errors", async () => {
    const error = await evaluateJev(input, {
      environment,
      fetchImpl: async () => {
        throw new Error("fixture-key");
      },
    }).catch((error) => error);
    expect(error).toBeInstanceOf(JevError);
    expect(jevErrorReport(error).error.code).toBe("jev_transport_failed");
    expect(JSON.stringify(jevErrorReport(error))).not.toContain("fixture-key");
  });
});

describe("Jev MCP boundary", () => {
  it("advertises typed external evaluation and invokes it without a backend", async () => {
    const catalogue = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/list" }, {});
    expect(catalogue.tools.find((tool) => tool.name === "jev_evaluate")).toMatchObject({
      inputSchema: { required: ["state", "questions"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    });
    const request = vi.fn();
    const result = await handleMcpRequest(
      { jsonrpc: "2.0", method: "tools/call", params: { name: "jev_evaluate", arguments: input } },
      environment,
      { jevFetch: reply(), request },
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      schemaVersion: 1,
      kind: "dure.jev.evaluation",
      ...response,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(request).not.toHaveBeenCalled();
  });

  it("returns configuration failures as tool errors", async () => {
    const result = await handleMcpRequest(
      { jsonrpc: "2.0", method: "tools/call", params: { name: "jev_evaluate", arguments: input } },
      {},
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "jev_api_key_missing" } },
    });
  });
});
