import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, sign, verify, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttp2Server, connect } from "node:http2";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createApnsSender } from "./apns.mjs";
import { createPushServer } from "./service.mjs";
import { ko } from "../src/locales/ko.ts";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dure-push-845-test-"));
after(() => rmSync(fixtureRoot, { recursive: true }));
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(fixtureRoot, "hub.key"), "-out", path.join(fixtureRoot, "hub.crt"), "-days", "1", "-subj", "/CN=push-fixture.invalid"], { stdio: "ignore" });
const certificate = new X509Certificate(readFileSync(path.join(fixtureRoot, "hub.crt")));
const hubKey = createPrivateKey(readFileSync(path.join(fixtureRoot, "hub.key")));
const fingerprint = `SHA256:${createHash("sha256").update(certificate.raw).digest("base64")}`;
const allowedHubs = new Set([fingerprint]);
const baseMessage = () => ({ version: 1, operation: "send", issuedAt: Math.floor(Date.now() / 1000), event: { kind: "approval", eventId: "host:session:approval:1" }, subscription: { token: "ab".repeat(32), environment: "sandbox", preference: "all", language: "en" } });

function envelope(message) {
  const bytes = Buffer.from(JSON.stringify(message));
  return {
    certificate: certificate.raw.toString("base64"),
    message: bytes.toString("base64"),
    signature: sign("sha256", Buffer.concat([Buffer.from("dure-push-request-v1\0"), bytes]), hubKey).toString("base64"),
  };
}

async function serving(sender, hubs = allowedHubs) {
  const server = createPushServer({ sender, allowedHubs: hubs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return (request, route = "send") => fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
}

test("registration checks authorization without sending an alert and cannot be replayed as a send", async () => {
  let sends = 0;
  const post = await serving({ async send() { sends++; return { status: "accepted" }; } });
  const registration = envelope({ ...baseMessage(), operation: "register", event: null });
  assert.equal((await post(registration, "register")).status, 200);
  assert.equal((await post(registration)).status, 403);
  assert.equal((await post(envelope(baseMessage()), "register")).status, 403);
  assert.equal(sends, 0);
});

test("an authenticated desktop delivers without any phone connection; replay and concurrent copies share one send", async () => {
  let sends = 0;
  const post = await serving({ async send() { sends++; await new Promise((resolve) => setTimeout(resolve, 20)); return { status: "accepted" }; } });
  const signed = envelope(baseMessage());
  const results = await Promise.all([post(signed), post(signed)]);
  assert.deepEqual(results.map((response) => response.status), [202, 202]);
  assert.equal((await post(signed)).status, 200);
  assert.equal(sends, 1);
});

test("an unauthorized Hub, changed recipient, expired request and oversized body cannot reach APNs", async () => {
  let sends = 0;
  const sender = { async send() { sends++; return { status: "accepted" }; } };
  const post = await serving(sender);
  const untrusted = await serving(sender, new Set(["SHA256:untrusted"]));
  assert.equal((await untrusted(envelope(baseMessage()))).status, 403);
  const changed = envelope(baseMessage());
  const tampered = baseMessage();
  tampered.subscription.token = "cd".repeat(32);
  changed.message = Buffer.from(JSON.stringify(tampered)).toString("base64");
  assert.equal((await post(changed)).status, 403);
  assert.equal((await post(envelope({ ...baseMessage(), issuedAt: 1 }))).status, 403);
  assert.equal((await post({ message: "x".repeat(17 * 1024) })).status, 413);
  assert.equal(sends, 0);
});

test("approvals-only filters completion and a provider failure remains retryable", async () => {
  let sends = 0;
  const post = await serving({ async send() { return { status: ++sends === 1 ? "unavailable" : "accepted" }; } });
  const completion = baseMessage();
  completion.subscription.preference = "approvals";
  completion.event.kind = "done";
  assert.equal((await post(envelope(completion))).status, 200);
  assert.equal(sends, 0);
  const request = envelope(baseMessage());
  assert.equal((await post(request)).status, 502);
  assert.equal((await post(request)).status, 202);
  assert.equal(sends, 2);
});

test("HTTP/2 APNs alert has a valid ES256 provider token and no transcript or event identity", async () => {
  const apns = createHttp2Server();
  const streams = [];
  apns.on("session", (session) => streams.push(session));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const observed = new Promise((resolve) => apns.once("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { body += chunk; });
    stream.on("end", () => { stream.respond({ ":status": 200 }); stream.end(); resolve({ headers, body: JSON.parse(body) }); });
  }));
  apns.listen(0, "127.0.0.1");
  await once(apns, "listening");
  const sender = createApnsSender({
    key: privateKey.export({ type: "pkcs8", format: "pem" }), keyId: "TESTKEY123", teamId: "TESTTEAM12",
    openConnection(endpoint) {
      assert.equal(endpoint, "https://api.sandbox.push.apple.com");
      return connect(`http://127.0.0.1:${apns.address().port}`);
    },
  });
  try {
    const message = baseMessage();
    message.subscription.language = "ko";
    assert.deepEqual(await sender.send(message, fingerprint), { status: "accepted" });
    const { headers, body } = await observed;
    assert.equal(headers["apns-topic"], "dev.hebbian.ide.mobile");
    assert.equal(headers["apns-push-type"], "alert");
    assert.equal(headers["apns-priority"], "10");
    assert.equal(headers[":path"], `/3/device/${message.subscription.token}`);
    const jwt = headers.authorization.slice("bearer ".length).split(".");
    assert.equal(JSON.parse(Buffer.from(jwt[0], "base64url")).alg, "ES256");
    assert.equal(JSON.parse(Buffer.from(jwt[1], "base64url")).iss, "TESTTEAM12");
    assert(verify("sha256", Buffer.from(`${jwt[0]}.${jwt[1]}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[2], "base64url")));
    assert.deepEqual(body, { aps: { alert: { title: "Dure", body: ko["notifications.push.approvalBody"] }, sound: "default" } });
  } finally {
    sender.close();
    for (const stream of streams) stream.destroy();
    await new Promise((resolve) => apns.close(resolve));
  }
});

test("an active but unfinished APNs response still meets the total delivery deadline", async (context) => {
  const apns = createHttp2Server();
  const sessions = [];
  apns.on("session", (session) => sessions.push(session));
  const arrived = new Promise((resolve) => apns.once("stream", (stream) => {
    stream.resume();
    stream.on("end", () => { stream.respond({ ":status": 200 }); resolve(stream); });
  }));
  apns.listen(0, "127.0.0.1");
  await once(apns, "listening");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const sender = createApnsSender({
    key: privateKey.export({ type: "pkcs8", format: "pem" }), keyId: "TESTKEY123", teamId: "TESTTEAM12",
    openConnection: () => connect(`http://127.0.0.1:${apns.address().port}`),
  });
  try {
    let result;
    const delivery = sender.send(baseMessage(), fingerprint).then((value) => { result = value; });
    const stream = await arrived;
    context.mock.timers.tick(6000);
    stream.write(" ");
    await new Promise(setImmediate);
    assert.equal(result, undefined);
    context.mock.timers.tick(1000);
    await new Promise(setImmediate);
    assert.deepEqual(result, { status: "unavailable" });
    await delivery;
  } finally {
    sender.close();
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => apns.close(resolve));
  }
});
