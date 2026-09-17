// Executed by the Rust contract test with a disposable Hub's signed requests.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { connect, createServer as createHttp2Server } from "node:http2";
import { createApnsSender } from "./apns.mjs";
import { createPushServer } from "./service.mjs";
import { ko } from "../src/locales/ko.ts";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const [registration, notification] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const certificate = new X509Certificate(Buffer.from(registration.certificate, "base64"));
const fingerprint = `SHA256:${createHash("sha256").update(certificate.raw).digest("base64")}`;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const apns = createHttp2Server();
const sessions = [];
let deliveries = 0;
apns.on("session", (session) => sessions.push(session));
apns.on("stream", (stream, headers) => {
  let body = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { body += chunk; });
  stream.on("end", () => {
    assert.equal(headers["apns-push-type"], "alert");
    assert.equal(JSON.parse(body).aps.alert.body, ko["notifications.push.approvalBody"]);
    deliveries++;
    stream.respond({ ":status": 200 });
    stream.end();
  });
});
apns.listen(0, "127.0.0.1");
await once(apns, "listening");
const sender = createApnsSender({ key: privateKey.export({ type: "pkcs8", format: "pem" }), keyId: "TESTKEY123", teamId: "TESTTEAM12", openConnection: () => connect(`http://127.0.0.1:${apns.address().port}`) });
const gateway = createPushServer({ sender, allowedHubs: new Set([fingerprint]) });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const post = (route, body) => fetch(`http://127.0.0.1:${gateway.address().port}/v1/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
try {
  assert.equal((await post("register", registration)).status, 200);
  assert.equal(deliveries, 0);
  assert.equal((await post("send", registration)).status, 403);
  assert.equal((await post("send", notification)).status, 202);
  assert.equal((await post("send", notification)).status, 200);
  assert.equal(deliveries, 1);
  process.stdout.write("Rust Hub signature -> gateway -> HTTP/2 APNs alert: passed\n");
} finally {
  gateway.closeAllConnections();
  await new Promise((resolve) => gateway.close(resolve));
  sender.close();
  for (const session of sessions) session.destroy();
  await new Promise((resolve) => apns.close(resolve));
}
