import assert from "node:assert/strict";
import { test } from "vitest";
import { collectBrowserCommand } from "../cli/lib/browser-command.mjs";

const resource = { resource_id: "network", generation: "generation", workspace_id: "workspace" };
const page = { resource, page_id: "selected", document_revision: "7" };
const requests = [
  ["9007199254740993", "https://fixture/api/한글,one", "GET", "Fetch", 200],
  ["9007199254740994", "https://fixture/api/한글,one", "POST", "XHR", 201],
  ["9007199254740995", "https://fixture/image", "GET", "Image", 404],
  ["9007199254740996", "https://fixture/api/pending", "POST", "Fetch", null],
  ["9007199254740997", "https://fixture/api/failed", "GET", "Fetch", null],
  ["9007199254740998", "https://fixture/api/failure", "POST", "Fetch", 503],
  ["9007199254740999", "https://fixture/--backend peer", "GET", "Other", 302],
].map(([sequence, url, method, resource_type, status], index) => ({ sequence, url, method, resource_type, status,
  state: index === 3 ? "pending" : index === 4 ? "failed" : "finished", error: index === 4 ? "failed" : null, metadata_truncated: false }));
const snapshot = { page, complete: false, pending: 1, idle: false, quiet_ms: null, history_truncated: true, requests };

function fixture(reply = snapshot) {
  const calls = [];
  const run = (args) => collectBrowserCommand({ args, sourceEnvironment: {},
    resolveBackend: async () => ({ profile: { id: "selected" } }),
    requestBackend: async (_profile, { body, requiredCapabilities }) => {
      calls.push(body);
      assert.deepEqual(requiredCapabilities, ["browser.resource.v1", "browser.network.v1"]);
      return { result: { result: body.kind === "observe" ? { control: { resource, current_page: page, controller: null }, pages: [{ page }] } : reply } };
    } });
  return { run, calls };
}

const filters = [
  [["--filter", "api/한글,one"], [0, 1]],
  [["--filter", "API"], []],
  [["--type", "xhr, fetch"], [0, 1, 3, 4, 5]],
  [["--method", "pOsT"], [1, 3, 5]],
  [["--status", "201"], [1]],
  [["--status", "2XX"], [0, 1]],
  [["--status", "201-503"], [1, 2, 5, 6]],
  [["--filter", "api", "--type", "fetch,XHR", "--method", "post", "--status", "2xx"], [1]],
  [["--filter", "--backend peer"], [6]],
];

test.each(filters)("direct and native request filters %j preserve the Host snapshot and read authority", async (flags, indices) => {
  for (const args of [["network", resource.resource_id, ...flags], ["exec", resource.resource_id, "--command", "network requests " + flags.map((value) => `'${value}'`).join(" ")]]) {
    const { run, calls } = fixture();
    const result = await run(args);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result, { ...snapshot, requests: indices.map((index) => requests[index]) });
    assert.deepEqual(calls, [{ kind: "observe", resource_id: resource.resource_id }, { kind: "network", page }]);
    assert.equal(snapshot.requests, requests);
    assert.equal(snapshot.requests.length, 7);
  }
});

test("the latest limit applies after filtering and does not infer idle from an empty projection", async () => {
  for (const [status, expected, truncated] of [["2xx", [requests[1]], true], ["4xx", [requests[2]], false], ["1xx", [], false]]) {
    const { run } = fixture();
    const result = await run(["network", resource.resource_id, "--status", status, "--limit", "1"]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.result, { ...snapshot, requests: expected, truncated });
  }
});

test("network snapshots reject replaced resource, page and document identities even without filters", async () => {
  const replies = [null, { ...snapshot, requests: null }, { ...snapshot, page: { ...page, page_id: "peer" } },
    { ...snapshot, page: { ...page, document_revision: "8" } },
    ...["resource_id", "generation", "workspace_id"].map((key) => ({ ...snapshot, page: { ...page, resource: { ...resource, [key]: "replaced" } } }))];
  for (const reply of replies) {
    for (const flags of [[], ["--filter", "api"]]) {
      const { run, calls } = fixture(reply);
      const result = await run(["network", resource.resource_id, ...flags]);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.error.code, "browser_response_invalid");
      assert.equal(calls.length, 2);
    }
  }
});

test("malformed filters, duplicate options and native routing injection reject before backend contact", async () => {
  const flags = [["--filter"], ["--type", ""], ["--type", "fetch,,xhr"], ["--method", "G ET"],
    ["--status", "2x"], ["--status", "200-"], ["--status", "500-200"], ["--status", "200.0"],
    ["--filter", "a", "--filter", "b"], ["--method", "GET", "--method", "POST"]];
  const args = flags.flatMap((values) => [["network", resource.resource_id, ...values], ["exec", resource.resource_id, "--command", "network requests " + values.map((value) => `'${value}'`).join(" ")]]);
  args.push(...["network requests --backend peer", "network requests --page peer", "network requests extra"].map((command) => ["exec", resource.resource_id, "--command", command]));
  args.push(...["show", "reload", "capture"].map((command) => [command, resource.resource_id, "--filter", "api"]));
  for (const values of args) {
    let contacts = 0;
    const result = await collectBrowserCommand({ args: values, sourceEnvironment: {}, resolveBackend: async () => { contacts++; throw new Error("unexpected backend"); } });
    assert.equal(result.ok, false, JSON.stringify(values));
    assert.equal(contacts, 0, JSON.stringify(values));
  }
});

test("network filtering preserves backend errors and never retries a lost observation", async () => {
  for (const failure of [{ error: { code: "browser_document_changed" } }, { result: { response: { success: false, error: "browser_network_observation_lost" } } }, "lost"]) {
    const calls = [];
    const result = await collectBrowserCommand({ args: ["network", resource.resource_id, "--filter", "api"], sourceEnvironment: {},
      resolveBackend: async () => ({ profile: { id: "chosen" } }),
      requestBackend: async (_profile, { body }) => {
        calls.push(body.kind);
        if (body.kind === "observe") return { result: { result: { control: { resource, current_page: page }, pages: [{ page }] } } };
        if (failure === "lost") throw new Error("browser_response_lost");
        return { result: failure };
      } });
    assert.equal(result.ok, false);
    if (failure === "lost") assert.equal(result.error.code, "browser_response_lost");
    else for (const [key, value] of Object.entries(failure)) assert.deepEqual(result[key], value);
    assert.deepEqual(calls, ["observe", "network"]);
  }
});

test("filtered rows must contain actual request fields and an optional numeric status", async () => {
  for (const request of [null, { ...requests[0], url: null }, { ...requests[0], method: 1 }, { ...requests[0], resource_type: null }, { ...requests[0], status: "200" }, { ...requests[0], status: -1 }]) {
    const { run } = fixture({ ...snapshot, requests: [request] });
    const result = await run(["network", resource.resource_id, "--filter", "api"]);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "browser_response_invalid");
  }
});
