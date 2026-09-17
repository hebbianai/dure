import fs from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { requestAppControl } from "../app-control-client.mjs";
import { writeSlackJson } from "./journal.mjs";

export async function requestSlackShare(file, request) {
  return requestSlackControl(file, "/slack/share", request, 300_000);
}

export async function requestSlackStatus(file, teamId) {
  return requestSlackControl(file, "/slack/status", { schemaVersion: 1, teamId }, 5_000);
}

async function requestSlackControl(file, endpoint, request, timeoutMs) {
  const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
  if (descriptor.kind !== "dure.slack.connector" || descriptor.schemaVersion !== 1 || descriptor.teamId !== request.teamId) {
    throw new Error("The Slack connector belongs to another workspace.");
  }
  const { result } = await requestAppControl({ descriptor, path: endpoint, body: request, timeoutMs });
  return result;
}

export async function serveSlackControl({ file, teamId, share, status }) {
  const token = randomUUID();
  const generation = randomUUID();
  const requests = new Set();
  const server = createServer((request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    // A local website must not be able to use the owner's connector. The
    // capability is read from a private descriptor, never from a URL or cookie.
    if (request.headers.origin || request.headers.authorization !== `Bearer ${token}`) {
      send(403, { ok: false, error: { code: "slack_control_unauthorized" } });
      return;
    }
    const work = (async () => {
      try {
        if (request.method !== "POST" || !["/slack/share", "/slack/status"].includes(request.url)) {
          send(404, { ok: false, error: { code: "slack_control_not_found" } });
          return;
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 64 * 1024) throw new Error("Request too large");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.schemaVersion !== 1 || body.teamId !== teamId) {
          throw Object.assign(new Error("Workspace mismatch"), { code: "slack_control_workspace_mismatch" });
        }
        const result = request.url === "/slack/share" ? await share(body) : {
          schemaVersion: 1, teamId, ...status(), generation,
        };
        send(200, { ok: true, result });
      } catch (error) {
        const code = /^[a-z_]+$/.test(error.code ?? "") ? error.code :
          request.url === "/slack/share" ? "slack_share_failed" : "slack_control_failed";
        send(400, { ok: false, error: { code, message: "Dure could not complete this Slack request." } });
      }
    })();
    requests.add(work);
    void work.finally(() => requests.delete(work)).catch(() => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const descriptor = { schemaVersion: 1, kind: "dure.slack.connector", teamId, generation, port: server.address().port, token };
  try { writeSlackJson(file, descriptor); }
  catch (error) { server.closeAllConnections(); server.close(); throw error; }
  return {
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await Promise.allSettled([...requests]);
      await closed;
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file);
    },
  };
}
