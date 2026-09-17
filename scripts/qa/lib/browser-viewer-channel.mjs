import { once } from "node:events";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

// This is disposable QA coordination, never the product browser transport.
export async function startBrowserViewerChannel() {
  const token = randomBytes(32).toString("hex");
  let configuration = {};
  let frame = null;
  const reports = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/u.test(origin)) {
      response.writeHead(403).end();
      return;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type",
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    try {
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 4 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
      }
      if (request.method === "POST") {
        if (request.url === "/configuration") configuration = JSON.parse(body);
        else if (request.url === "/frame") frame = JSON.parse(body);
        else if (request.url === "/reports") {
          reports.push(JSON.parse(body));
          if (reports.length > 64) reports.shift();
        } else {
          response.writeHead(404).end();
          return;
        }
      }
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/reports"
            ? reports
            : request.url === "/frame"
              ? frame
              : configuration,
        ),
      );
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function browserViewerRequest(path, body) {
  const url = process.env.VITE_DURE_BROWSER_QA_CHANNEL;
  const token = process.env.VITE_DURE_BROWSER_QA_TOKEN;
  if (!url || !token) throw new Error("browser viewer QA channel is missing");
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`browser viewer QA channel returned ${response.status}`);
  return response.json();
}
