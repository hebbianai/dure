import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto, { createHash, createPrivateKey, generateKeyPairSync, sign, verify, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp2Server, connect } from "node:http2";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createApnsSender } from "./apns.mjs";
import { bindingId, openBindings } from "./bindings.mjs";
import { createChallenges } from "./challenges.mjs";
import { createBuckets, createLimits } from "./limits.mjs";
import { createPushServer } from "./service.mjs";
import { en } from "../src/locales/en.ts";
import { ko } from "../src/locales/ko.ts";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "dure-push-845-test-"));
after(() => rmSync(fixtureRoot, { recursive: true }));
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(fixtureRoot, "hub.key"), "-out", path.join(fixtureRoot, "hub.crt"), "-days", "1", "-subj", "/CN=push-fixture.invalid"], { stdio: "ignore" });
const certificate = new X509Certificate(readFileSync(path.join(fixtureRoot, "hub.crt")));
const hubKey = createPrivateKey(readFileSync(path.join(fixtureRoot, "hub.key")));
const fingerprint = `SHA256:${createHash("sha256").update(certificate.raw).digest("base64")}`;
const allowedHubs = new Set([fingerprint]);
const AUDIENCE = "https://push.example.org/";
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
  const server = createPushServer({ sender, allowedHubs: hubs, audiences: [AUDIENCE] });
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
  const untrusted = await serving(sender, new Set([`SHA256:${createHash("sha256").update("another computer").digest("base64")}`]));
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

test("the relay refuses an agent reference that is not an opaque identifier", async () => {
  let sends = 0;
  const post = await serving({ async send() { sends++; return { status: "accepted" }; } });
  for (const sessionId of ["/Users/me/project", "C:\\work\\repo", "Fix the build", "", "a".repeat(257), 7]) {
    const message = baseMessage();
    message.event.sessionId = sessionId;
    assert.equal((await post(envelope(message))).status, 403, String(sessionId));
  }
  assert.equal(sends, 0);
});

test("the relay refuses an approval reference that is not two opaque identifiers on an approval alert", async () => {
  let sends = 0;
  const post = await serving({ async send() { sends++; return { status: "accepted" }; } });
  const valid = { attentionId: "attention-3", terminalEpoch: "7" };
  for (const [change, label] of [
    [(event) => { event.approval = { ...valid, attentionId: "Run rm -rf /" }; }, "a sentence"],
    [(event) => { event.approval = { ...valid, terminalEpoch: "/dev/ttys001" }; }, "a path"],
    [(event) => { event.approval = { ...valid, summary: "git push" }; }, "an extra field"],
    [(event) => { event.approval = valid; delete event.sessionId; }, "no agent"],
    [(event) => { event.approval = valid; event.kind = "done"; }, "a completion"],
    [(event) => { event.approval = "attention-3"; }, "not an object"],
  ]) {
    const message = baseMessage();
    message.event.sessionId = "managed_1";
    change(message.event);
    assert.equal((await post(envelope(message))).status, 403, label);
  }
  assert.equal(sends, 0);
});

test("the relay refuses a reply reference that is not one opaque process on a finished turn", async () => {
  let sends = 0;
  const post = await serving({ async send() { sends++; return { status: "accepted" }; } });
  for (const [change, label] of [
    [(event) => { event.reply = { terminalEpoch: "/dev/ttys001" }; }, "a path"],
    [(event) => { event.reply = { terminalEpoch: "7", text: "run the tests" }; }, "an extra field"],
    [(event) => { event.reply = { terminalEpoch: "7" }; event.kind = "input"; }, "a question"],
    [(event) => { event.reply = { terminalEpoch: "7" }; delete event.sessionId; }, "no agent"],
    [(event) => { event.reply = "7"; }, "not an object"],
    [(event) => { event.kind = "question"; }, "an unknown kind"],
  ]) {
    const message = baseMessage();
    message.event.kind = "done";
    message.event.sessionId = "managed_1";
    change(message.event);
    assert.equal((await post(envelope(message))).status, 403, label);
  }
  assert.equal(sends, 0);
});

test("an agent's message is an alert kind, and its notice is one opaque id on a message that names its agent", async () => {
  const sent = [];
  const post = await serving({ async send(message) { sent.push(message.event); return { status: "accepted" }; } });
  const notice = (change, eventId) => {
    const message = baseMessage();
    message.event = { kind: "message", eventId, sessionId: "managed_1", notice: "n.0123456789abcdef0123456789abcdef" };
    change(message.event);
    return post(envelope(message));
  };
  for (const [change, label] of [
    [(event) => { event.kind = "approval"; }, "on an approval"],
    [(event) => { event.kind = "done"; }, "on a finished turn"],
    [(event) => { event.kind = "input"; }, "on a question"],
    [(event) => { delete event.sessionId; }, "no agent"],
    [(event) => { event.notice = "Build is green"; }, "the message's text"],
    [(event) => { event.notice = "/Users/me/notes.txt"; }, "a path"],
    [(event) => { event.notice = ""; }, "empty"],
    [(event) => { event.notice = "n".repeat(257); }, "too long"],
    [(event) => { event.notice = { id: "n.1" }; }, "not a string"],
  ]) assert.equal((await notice(change, "notify:refused")).status, 403, label);
  assert.equal(sent.length, 0);
  assert.equal((await notice(() => {}, "notify:n.1")).status, 202);
  assert.equal((await notice((event) => { delete event.notice; }, "notify:n.2")).status, 202, "a message without a notice keeps the generic text");
  assert.deepEqual(sent.map((event) => event.notice), ["n.0123456789abcdef0123456789abcdef", undefined]);
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

test("HTTP/2 APNs alert has a valid ES256 provider token and carries the agent's identifier, no transcript or event identity", async () => {
  const apns = createHttp2Server();
  const streams = [];
  apns.on("session", (session) => streams.push(session));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bodies = [];
  const observed = new Promise((resolve) => apns.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { body += chunk; });
    stream.on("end", () => {
      stream.respond({ ":status": 200 });
      stream.end();
      bodies.push(JSON.parse(body));
      if (bodies.length === 1) resolve({ headers, body: bodies[0] });
    });
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
    message.event.sessionId = "managed_0123456789abcdef";
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
    // The whole payload: generic text, and identifiers only beside it — the
    // agent a tap opens, what happened and this computer, as the phone's
    // paired entry names it (unpadded). The phone's notification service
    // reads who and what from that computer (`mutable-content`).
    assert.deepEqual(body, {
      aps: { alert: { title: "Dure", body: ko["notifications.push.approvalBody"] }, sound: "default", "mutable-content": 1 },
      dure: { session: "managed_0123456789abcdef", kind: "approval", hub: fingerprint.replace(/=+$/, "") },
    });
    assert.equal(body.dure.hub.length, "SHA256:".length + 43);
    // An older desktop names no agent; its alert opens the app as before,
    // and there is nothing for the phone to read.
    assert.deepEqual(await sender.send(baseMessage(), fingerprint), { status: "accepted" });
    assert.deepEqual(bodies[1], { aps: { alert: { title: "Dure", body: en["notifications.push.approvalBody"] }, sound: "default" } });
    // An answerable approval adds its actions and its identity: still no request text.
    const answerable = baseMessage();
    answerable.event.sessionId = "managed_0123456789abcdef";
    answerable.event.approval = { attentionId: "attention-3", terminalEpoch: "7" };
    assert.deepEqual(await sender.send(answerable, fingerprint), { status: "accepted" });
    assert.deepEqual(bodies[2], {
      aps: { alert: { title: "Dure", body: en["notifications.push.approvalBody"] }, sound: "default", category: "dure.approval", "mutable-content": 1 },
      dure: {
        session: "managed_0123456789abcdef",
        kind: "approval",
        hub: fingerprint.replace(/=+$/, ""),
        approval: { attentionId: "attention-3", terminalEpoch: "7" },
      },
    });
    // A finished turn the phone can reply to adds its reply action and process.
    const repliable = baseMessage();
    repliable.event.kind = "done";
    repliable.event.sessionId = "managed_0123456789abcdef";
    repliable.event.reply = { terminalEpoch: "7" };
    assert.deepEqual(await sender.send(repliable, fingerprint), { status: "accepted" });
    assert.deepEqual(bodies[3], {
      aps: { alert: { title: "Dure", body: en["notifications.push.doneBody"] }, sound: "default", category: "dure.reply", "mutable-content": 1 },
      dure: { session: "managed_0123456789abcdef", kind: "done", hub: fingerprint.replace(/=+$/, ""), reply: { terminalEpoch: "7" } },
    });
    // A question in the terminal says so, and takes no reply.
    const question = baseMessage();
    question.event.kind = "input";
    question.event.sessionId = "managed_0123456789abcdef";
    assert.deepEqual(await sender.send(question, fingerprint), { status: "accepted" });
    assert.deepEqual(bodies[4], {
      aps: { alert: { title: "Dure", body: en["notifications.push.inputBody"] }, sound: "default", "mutable-content": 1 },
      dure: { session: "managed_0123456789abcdef", kind: "input", hub: fingerprint.replace(/=+$/, "") },
    });
    // An agent's message says one arrived, and carries only the id the
    // computer keeps its text under: no actions, never the text.
    const notified = baseMessage();
    notified.event = { kind: "message", eventId: "notify:n.1", sessionId: "managed_0123456789abcdef", notice: "n.1" };
    assert.deepEqual(await sender.send(notified, fingerprint), { status: "accepted" });
    assert.deepEqual(bodies[5], {
      aps: { alert: { title: "Dure", body: en["notifications.push.messageBody"] }, sound: "default", "mutable-content": 1 },
      dure: { session: "managed_0123456789abcdef", kind: "message", hub: fingerprint.replace(/=+$/, ""), notice: "n.1" },
    });
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

// v2 (#660): a grant the phone signed for this computer, from a phone key
// that proved it receives the token's alerts.

function hubIdentity(name, ...newkey) {
  const keyFile = path.join(fixtureRoot, `${name}.key`);
  const certificateFile = path.join(fixtureRoot, `${name}.crt`);
  execFileSync("openssl", ["req", "-x509", "-newkey", ...newkey, "-nodes", "-keyout", keyFile, "-out", certificateFile, "-days", "1", "-subj", `/CN=${name}.invalid`], { stdio: "ignore" });
  const own = new X509Certificate(readFileSync(certificateFile));
  return { certificate: own, key: createPrivateKey(readFileSync(keyFile)), hub: `SHA256:${createHash("sha256").update(own.raw).digest("base64").replace(/=+$/, "")}` };
}
const hubA = { certificate, key: hubKey, hub: fingerprint.replace(/=+$/, "") };
const hubB = hubIdentity("other-hub", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1");
const rsaHub = hubIdentity("rsa-hub", "rsa:2048");

const NOW = 1_795_600_000_000;
const DAY = 24 * 60 * 60;
function clock(start = NOW) {
  let at = start;
  const now = () => at;
  now.advance = (ms) => { at += ms; };
  return now;
}
const seconds = (now) => Math.floor(now() / 1000);
const subscriptionOf = (change = {}) => ({ token: "ab".repeat(32), environment: "sandbox", preference: "all", language: "en", ...change });
const approval = (eventId = "hmux:pane-1:7:attention:3") => ({ kind: "approval", eventId, sessionId: "managed_1", approval: { attentionId: "attention-3", terminalEpoch: "7" } });

function phoneKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { privateKey, key: point.toString("base64url"), keyId: `k.${createHash("sha256").update(point).digest().subarray(0, 8).toString("hex")}` };
}

/** What the phone mints for one paired computer (S0's canonical claims). */
function grantFor(phone, now, { by = hubA, hub = by.hub, subscription = subscriptionOf(), epoch = 1, issuedAt = seconds(now), expiresAt = issuedAt + 14 * DAY, nonce, text } = {}) {
  const claims = Buffer.from(text ?? JSON.stringify({ version: 1, token: subscription.token, environment: subscription.environment, hub, preference: subscription.preference, epoch, issuedAt, expiresAt, ...(nonce ? { nonce } : {}) }));
  return { key: phone.key, claims: claims.toString("base64url"), signature: sign("sha256", Buffer.concat([Buffer.from("dure-push-grant-v1\0"), claims]), phone.privateKey).toString("base64url") };
}

function signedBy(by, message, context = "dure-push-request-v2\0") {
  const bytes = Buffer.from(JSON.stringify(message));
  return { certificate: by.certificate.raw.toString("base64"), message: bytes.toString("base64"), signature: sign("sha256", Buffer.concat([Buffer.from(context), bytes]), by.key).toString("base64") };
}
const v2 = (now, operation, grant, { by = hubA, subscription = subscriptionOf(), event = approval(), audience = AUDIENCE } = {}) =>
  signedBy(by, { version: 2, operation, issuedAt: seconds(now), audience, event: operation === "register" ? null : event, subscription, grant });

function recorder({ send = "accepted", challenge = "accepted" } = {}) {
  const sends = [];
  const challenges = [];
  return {
    sends,
    challenges,
    get calls() { return sends.length + challenges.length; },
    async send(message, hub) { sends.push({ message, hub }); return { status: send }; },
    async challenge(subscription, payload, collapseId) { challenges.push({ subscription, ...payload, collapseId }); return { status: challenge }; },
  };
}

async function service(options) {
  const server = createPushServer({ audiences: [AUDIENCE], ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, headers = {}) => {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
  };
  post.health = async () => {
    const response = await fetch(`${base}/health`);
    return { status: response.status, body: await response.json() };
  };
  return post;
}

/** The phone's first sync to one computer: register, catch the challenge, sign it back. */
async function bind(post, sender, phone, now, options = {}) {
  const asked = await post("/v2/register", v2(now, "register", grantFor(phone, now, options), options));
  assert.deepEqual(asked, { status: 202, body: { status: "challenge_sent", key: phone.keyId }, retryAfter: null });
  const { nonce } = sender.challenges.at(-1);
  const proved = await post("/v2/register", v2(now, "register", grantFor(phone, now, { ...options, nonce }), options));
  assert.deepEqual(proved.body, { status: "registered" });
  return proved;
}

/** Counts every node:crypto verify call, the service's and the grant's. */
function countVerify(context) {
  const original = crypto.verify;
  let calls = 0;
  crypto.verify = (...args) => { calls++; return original(...args); };
  syncBuiltinESMExports();
  context.after(() => { crypto.verify = original; syncBuiltinESMExports(); });
  return () => calls;
}

const tempDirectory = () => mkdtempSync(path.join(fixtureRoot, "state-"));
const fileText = (directory) => ["bindings.json", "bindings.log"].map((file) => readFileSync(path.join(directory, file), "utf8")).join("\n");

test("v2: a phone key binds only by signing back the challenge alert, and nothing is written before", async () => {
  const now = clock();
  const directory = tempDirectory();
  const bindings = await openBindings({ directory, now });
  after(() => bindings.close());
  const sender = recorder();
  const post = await service({ sender, now, bindings });
  const phone = phoneKey();
  const grant = grantFor(phone, now);

  assert.deepEqual(await post("/v2/register", v2(now, "register", grant)), { status: 202, body: { status: "challenge_sent", key: phone.keyId }, retryAfter: null });
  assert.equal(sender.challenges.length, 1);
  const [challenge] = sender.challenges;
  assert.match(challenge.nonce, /^[0-9a-f]{32}$/);
  assert.equal(challenge.key, phone.keyId);
  assert.equal(challenge.collapseId, bindingId("sandbox", "ab".repeat(32)));
  assert.deepEqual(challenge.subscription, subscriptionOf());
  assert.equal(fileText(directory), `{"version":1,"bindings":{}}\n`, "nothing unproven is written");

  // The pending challenge is reused and pushed again at most once a minute.
  assert.equal((await post("/v2/register", v2(now, "register", grant))).status, 202);
  assert.equal(sender.challenges.length, 1);
  now.advance(60_000);
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phone, now)))).status, 202);
  assert.equal(sender.challenges.length, 2);
  assert.equal(sender.challenges[1].nonce, challenge.nonce);

  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now)))).status, 403, "no alert before the proof");
  const wrong = await post("/v2/register", v2(now, "register", grantFor(phone, now, { nonce: "0".repeat(32) })));
  assert.equal(wrong.body.status, "challenge_sent", "a wrong nonce proves nothing");
  assert.equal(fileText(directory), `{"version":1,"bindings":{}}\n`);

  const proved = await post("/v2/register", v2(now, "register", grantFor(phone, now, { nonce: challenge.nonce })));
  assert.deepEqual(proved, { status: 200, body: { status: "registered" }, retryAfter: null });
  assert.equal(readFileSync(path.join(directory, "bindings.log"), "utf8").trim().split("\n").length, 1, "the proven bind is journalled");

  const alert = v2(now, "send", grantFor(phone, now));
  assert.deepEqual(await post("/v2/send", alert), { status: 202, body: { status: "accepted" }, retryAfter: null });
  assert.equal((await post("/v2/send", alert)).body.status, "duplicate");
  assert.equal(sender.sends.length, 1);
  assert.equal(sender.sends[0].hub, hubA.hub);
  assert.equal(sender.challenges.length, 2);
  // A later computer of the same phone registers against the binding at once.
  assert.deepEqual((await post("/v2/register", v2(now, "register", grantFor(phone, now, { by: hubB }), { by: hubB }))).body, { status: "registered" });
  assert.equal(sender.challenges.length, 2);
});

test("v2: the challenge and alerts reach APNs as fixed text and identifiers, never the grant or a message's text", async () => {
  const apns = createHttp2Server();
  const sessions = [];
  const delivered = [];
  apns.on("session", (session) => sessions.push(session));
  apns.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { body += chunk; });
    stream.on("end", () => {
      delivered.push({ headers, body: JSON.parse(body) });
      stream.respond({ ":status": 200 });
      stream.end();
    });
  });
  apns.listen(0, "127.0.0.1");
  await once(apns, "listening");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = clock(Date.now());
  const apnsSender = createApnsSender({ key: privateKey.export({ type: "pkcs8", format: "pem" }), keyId: "TESTKEY123", teamId: "TESTTEAM12", now, openConnection: () => connect(`http://127.0.0.1:${apns.address().port}`) });
  const nonces = [];
  const sender = { send: apnsSender.send, async challenge(subscription, payload, collapseId) { nonces.push(payload.nonce); return apnsSender.challenge(subscription, payload, collapseId); } };
  try {
    const post = await service({ sender, now });
    const phone = phoneKey();
    const subscription = subscriptionOf({ language: "ko" });
    assert.equal((await post("/v2/register", v2(now, "register", grantFor(phone, now, { subscription }), { subscription }))).status, 202);
    const [setup] = delivered;
    assert.equal(setup.headers[":path"], `/3/device/${subscription.token}`);
    assert.equal(setup.headers["apns-push-type"], "alert");
    assert.equal(setup.headers["apns-priority"], "10");
    assert.equal(setup.headers["apns-expiration"], String(seconds(now) + 600));
    assert.equal(setup.headers["apns-collapse-id"], bindingId(subscription.environment, subscription.token));
    assert.deepEqual(setup.body, { aps: { alert: { title: "Dure", body: ko["notifications.push.setupBody"] } }, dure: { challenge: nonces[0], key: phone.keyId } });

    const proof = grantFor(phone, now, { subscription, nonce: nonces[0] });
    assert.equal((await post("/v2/register", v2(now, "register", proof, { subscription }))).status, 200);
    assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { subscription }), { subscription }))).status, 202);
    assert.equal(delivered.length, 2);
    // The same shape as a v1 alert: no grant, key, claims or nonce.
    assert.deepEqual(delivered[1].body, {
      aps: { alert: { title: "Dure", body: ko["notifications.push.approvalBody"] }, sound: "default", category: "dure.approval", "mutable-content": 1 },
      dure: { session: "managed_1", kind: "approval", hub: hubA.hub, approval: { attentionId: "attention-3", terminalEpoch: "7" } },
    });
    assert.equal(en["notifications.push.setupBody"], "Dure alerts are on for this iPhone.");

    // An agent's message (`dure notify`): one alert with its own fixed text and
    // no actions. The service only ever sees the id the computer keeps the
    // text under, and passes it on for the phone to ask that computer.
    const message = { kind: "message", eventId: "notify:n.0123456789abcdef0123456789abcdef", sessionId: "managed_1", notice: "n.0123456789abcdef0123456789abcdef" };
    assert.deepEqual(await post("/v2/send", v2(now, "send", grantFor(phone, now, { subscription }), { subscription, event: message })), { status: 202, body: { status: "accepted" }, retryAfter: null });
    assert.equal(delivered.length, 3);
    assert.equal(delivered[2].headers["apns-push-type"], "alert");
    assert.deepEqual(delivered[2].body, {
      aps: { alert: { title: "Dure", body: ko["notifications.push.messageBody"] }, sound: "default", "mutable-content": 1 },
      dure: { session: "managed_1", kind: "message", hub: hubA.hub, notice: message.notice },
    });
    assert.equal(en["notifications.push.messageBody"], "An agent sent you a message.");
    // A notice belongs to a message alone, even from the bound key.
    const misplaced = { ...approval("hmux:pane-1:7:attention:4"), notice: message.notice };
    assert.deepEqual(await post("/v2/send", v2(now, "send", grantFor(phone, now, { subscription }), { subscription, event: misplaced })), { status: 403, body: { status: "refused" }, retryAfter: null });
    assert.equal(delivered.length, 3);
  } finally {
    apnsSender.close();
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => apns.close(resolve));
  }
});

test("v2: a key with a valid grant but no proof cannot bind or send; one that proves receipt replaces the binding", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now });
  const owner = phoneKey();
  await bind(post, sender, owner, now);
  const squatter = phoneKey();
  // The same answer as for an unbound token: it reveals nothing about the binding.
  assert.deepEqual(await post("/v2/register", v2(now, "register", grantFor(squatter, now))), { status: 202, body: { status: "challenge_sent", key: squatter.keyId }, retryAfter: null });
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(squatter, now, { nonce: "1".repeat(32) })))).body.status, "challenge_sent");
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(squatter, now)))).status, 403);
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(owner, now)))).status, 202, "the owner keeps its binding");

  // A reinstalled phone has a new key and proves receipt again.
  const reinstalled = phoneKey();
  now.advance(60_000);
  await bind(post, sender, reinstalled, now);
  assert.deepEqual(await post("/v2/send", v2(now, "send", grantFor(owner, now), { event: approval("e2") })), { status: 403, body: { status: "refused" }, retryAfter: null });
  // A fourth challenge for the token within the hour waits; the old key must prove receipt again.
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(owner, now)))).body.status, "rate_limited");
  now.advance(20 * 60_000);
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(owner, now)))).body.status, "challenge_sent");
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(reinstalled, now), { event: approval("e3") }))).status, 202);
  assert.equal(sender.sends.length, 2);
});

test("v2: every grant refusal happens before APNs, and only the bound key hears why", async () => {
  const now = clock();
  const sender = recorder();
  const from = await service({ sender, now, clientAddressHeader: "X-Client" });
  // A client of its own per request: the per-client failure limit is tested apart.
  let client = 0;
  const post = (route, body) => from(route, body, { "x-client": `client-${++client}` });
  const phone = phoneKey();
  await bind(post, sender, phone, now, { epoch: 2 });
  const calls = sender.calls;
  const stranger = phoneKey();
  const refused = { status: 403, body: { status: "refused" }, retryAfter: null };
  const subscription = subscriptionOf();
  const tamper = (grant) => ({ ...grant, signature: Buffer.from(grant.signature, "base64url").map((byte, index, bytes) => (index === bytes.length - 1 ? byte ^ 1 : byte)).toString("base64url") });
  const offCurve = (grant) => {
    const point = Buffer.from(grant.key, "base64url");
    point[point.length - 1] ^= 1;
    return { ...grant, key: point.toString("base64url") };
  };
  const canonical = JSON.stringify({ version: 1, token: subscription.token, environment: "sandbox", hub: hubA.hub, preference: "all", epoch: 2, issuedAt: seconds(now), expiresAt: seconds(now) + 14 * DAY });
  for (const key of [phone, stranger]) {
    for (const [label, grant, options] of [
      ["another computer's fingerprint", grantFor(key, now, { epoch: 2, hub: hubB.hub })],
      ["another token", grantFor(key, now, { epoch: 2, subscription: subscriptionOf({ token: "cd".repeat(32) }) })],
      ["another environment", grantFor(key, now, { epoch: 2, subscription: subscriptionOf({ environment: "production" }) })],
      ["another preference", grantFor(key, now, { epoch: 2, subscription: subscriptionOf({ preference: "approvals" }) })],
      ["a lifetime over 15 days", grantFor(key, now, { epoch: 2, expiresAt: seconds(now) + 15 * DAY + 1 })],
      ["non-canonical claims", grantFor(key, now, { text: canonical.replace(',"token"', ', "token"') })],
      ["a tampered signature", tamper(grantFor(key, now, { epoch: 2 }))],
      ["a point off the curve", offCurve(grantFor(key, now, { epoch: 2 }))],
      ["a grant signed by another key", { ...grantFor(stranger, now, { epoch: 2 }), key: key === phone ? phone.key : phoneKey().key }],
      ["a grant for an approvals-only phone under an all subscription", grantFor(key, now, { epoch: 2, subscription: subscriptionOf({ preference: "approvals" }) }), { subscription }],
    ]) {
      for (const operation of ["register", "send"]) {
        assert.deepEqual(await post(`/v2/${operation}`, v2(now, operation, grant, options)), refused, `${label} (${operation}, ${key === phone ? "bound" : "unbound"} key)`);
      }
    }
  }
  // Expired and future grants are refused bare to anyone but the bound key.
  for (const [label, change] of [["expired", { issuedAt: seconds(now) - 14 * DAY }], ["issued too far ahead", { issuedAt: seconds(now) + 301 }]]) {
    for (const operation of ["register", "send"]) {
      assert.deepEqual(await post(`/v2/${operation}`, v2(now, operation, grantFor(stranger, now, { epoch: 2, ...change }))), refused, `${label} (${operation}, unbound key)`);
      assert.deepEqual((await post(`/v2/${operation}`, v2(now, operation, grantFor(phone, now, { epoch: 2, ...change })))).body, { status: "grant_expired" }, `${label} (${operation}, bound key)`);
    }
  }
  for (const operation of ["register", "send"]) {
    assert.deepEqual(await post(`/v2/${operation}`, v2(now, operation, grantFor(phone, now, { epoch: 1 }))), { status: 403, body: { status: "grant_superseded" }, retryAfter: null }, operation);
  }
  assert.equal(sender.calls, calls, "no refused grant reached APNs");
});

test("v2: a raised epoch supersedes older grants, including those a forgotten computer kept", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now });
  const phone = phoneKey();
  await bind(post, sender, phone, now);
  const kept = grantFor(phone, now, { by: hubB });
  assert.equal((await post("/v2/send", v2(now, "send", kept, { by: hubB }))).status, 202, "the computer is still paired");
  // The phone forgets hubB and syncs hubA at epoch 2.
  assert.deepEqual((await post("/v2/register", v2(now, "register", grantFor(phone, now, { epoch: 2 })))).body, { status: "registered" });
  assert.deepEqual((await post("/v2/send", v2(now, "send", kept, { by: hubB, event: approval("e2") }))).body, { status: "grant_superseded" });
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { epoch: 2 }), { event: approval("e3") }))).status, 202);
  assert.equal(sender.sends.length, 2);
});

test("v2: a non-P-256 computer certificate is refused before any signature check", async (context) => {
  const now = clock();
  const sender = recorder();
  const verifyCalls = countVerify(context);
  const post = await service({ sender, now, allowedHubs: [rsaHub.hub] });
  const phone = phoneKey();
  const before = verifyCalls();
  for (const operation of ["register", "send"]) {
    assert.equal((await post(`/v2/${operation}`, v2(now, operation, grantFor(phone, now, { by: rsaHub }), { by: rsaHub }))).status, 403);
    const legacy = { ...baseMessage(), operation, issuedAt: seconds(now), event: operation === "send" ? baseMessage().event : null };
    assert.equal((await post(`/v1/${operation}`, signedBy(rsaHub, legacy, "dure-push-request-v1\0"))).status, 403, "even an allowlisted RSA computer");
  }
  // Nor does an alert for a token the key is not bound to cost a check.
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now)))).status, 403);
  assert.equal(verifyCalls(), before);
  assert.equal(sender.calls, 0);
});

test("v2: a request names its audience, and its event id is an identifier", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now, audiences: ["https://push.example.org", "https://other.example.org/push"] });
  const phone = phoneKey();
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phone, now), { audience: "https://other.example.org/push/" }))).status, 202, "configured bases are normalized");
  for (const audience of ["https://elsewhere.example.org/", "https://push.example.org", null]) {
    assert.equal((await post("/v2/register", v2(now, "register", grantFor(phone, now), { audience }))).status, 403, String(audience));
  }
  await bind(post, sender, phone, now);
  for (const eventId of ["host session", "/Users/me", "é", "a".repeat(513)]) {
    assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: approval(eventId) }))).status, 403, eventId);
  }
  // A v1 signature does not pass for v2.
  const message = { version: 2, operation: "send", issuedAt: seconds(now), audience: AUDIENCE, event: approval(), subscription: subscriptionOf(), grant: grantFor(phone, now) };
  assert.equal((await post("/v2/send", signedBy(hubA, message, "dure-push-request-v1\0"))).status, 403);
  assert.equal((await post("/v2/send", signedBy(hubA, message))).status, 202);
  assert.throws(() => createPushServer({ sender, audiences: ["http://push.example.org/"] }), /audience/);
  assert.throws(() => createPushServer({ sender, audiences: ["https://push.example.org/?x=1"] }), /audience/);
  assert.throws(() => createPushServer({ sender }), /audience/);
});

test("v2: a token APNs refuses leaves no record and stays refused for a day", async () => {
  const now = clock();
  const directory = tempDirectory();
  const bindings = await openBindings({ directory, now });
  after(() => bindings.close());
  const sender = recorder({ challenge: "unregistered" });
  const post = await service({ sender, now, bindings });
  assert.deepEqual(await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now))), { status: 403, body: { status: "refused" }, retryAfter: null });
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)))).status, 403);
  assert.equal(sender.challenges.length, 1, "the second register cost no APNs call");
  assert.equal(fileText(directory), `{"version":1,"bindings":{}}\n`);
  now.advance(24 * 3600_000 + 1);
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)))).status, 403);
  assert.equal(sender.challenges.length, 2);
});

test("v2: an alert APNs calls unregistered drops the binding and tells the computer", async () => {
  const now = clock();
  const directory = tempDirectory();
  const bindings = await openBindings({ directory, now });
  after(() => bindings.close());
  let status = "accepted";
  const sender = { ...recorder(), async send() { return { status }; } };
  const post = await service({ sender, now, bindings });
  const phone = phoneKey();
  await bind(post, sender, phone, now);
  status = "unregistered";
  assert.deepEqual((await post("/v2/send", v2(now, "send", grantFor(phone, now)))), { status: 410, body: { status: "unregistered" }, retryAfter: null });
  assert.match(readFileSync(path.join(directory, "bindings.log"), "utf8"), /"op":"drop"/);
  assert.equal(bindings.size, 0);
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: approval("e2") }))).status, 403);
});

test("v2: challenge alerts from forged registers are capped per token, per client and overall", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now, clientAddressHeader: "X-Client" });
  // Keys that each hold a valid grant for one token, but no phone.
  for (let index = 0; index < 3; index++) assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)))).status, 202);
  const capped = await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)));
  assert.equal(capped.status, 429);
  assert.equal(capped.body.status, "rate_limited");
  assert(Number(capped.retryAfter) > 0);
  assert.equal(sender.challenges.length, 3, "three challenge alerts per token per hour");

  // One client starting challenges for many tokens.
  const fromOne = { "x-client": "198.51.100.7" };
  let started = 0;
  for (let index = 0; index < 11; index++) {
    now.advance(6000);
    const subscription = subscriptionOf({ token: index.toString(16).padStart(2, "0").repeat(32) });
    const result = await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now, { subscription }), { subscription }), fromOne);
    if (result.status === 202) started++;
    else assert.equal(result.status, 429);
  }
  assert.equal(started, 10, "ten challenges per client per hour");
  const elsewhere = subscriptionOf({ token: "ef".repeat(32) });
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now, { subscription: elsewhere }), { subscription: elsewhere }), { "x-client": "203.0.113.9" })).status, 202, "another client is not held back");

  // The overall budget, narrowed so a test can reach it.
  const narrowed = recorder();
  const overall = await service({ sender: narrowed, now, clientAddressHeader: "X-Client", limits: { ...createLimits({ now }), challenges: createBuckets({ capacity: 2, refillMs: 1800_000, maxKeys: 1, now }) } });
  const results = [];
  for (let index = 0; index < 3; index++) {
    const subscription = subscriptionOf({ token: (index + 32).toString(16).padStart(2, "0").repeat(32) });
    results.push((await overall("/v2/register", v2(now, "register", grantFor(phoneKey(), now, { subscription }), { subscription }), { "x-client": `192.0.2.${index}` })).status);
  }
  assert.deepEqual(results, [202, 202, 429]);
  assert.equal(narrowed.challenges.length, 2);
});

test("v2: registers refused by a challenge budget leave nothing behind for a real phone to wait on", async () => {
  const now = clock();
  const sender = recorder();
  // A table of two and one challenge per client, so a test can try to fill it.
  const limits = { ...createLimits({ now }), challengeStarts: createBuckets({ capacity: 1, refillMs: 3600_000, now }) };
  const post = await service({ sender, now, limits, challenges: createChallenges({ now, max: 2 }), clientAddressHeader: "X-Client" });
  const attacker = { "x-client": "198.51.100.66" };
  const forged = (index) => {
    const subscription = subscriptionOf({ token: (index + 64).toString(16).padStart(2, "0").repeat(32) });
    return v2(now, "register", grantFor(phoneKey(), now, { subscription }), { subscription });
  };
  assert.equal((await post("/v2/register", forged(0), attacker)).status, 202);
  for (let index = 1; index < 6; index++) assert.equal((await post("/v2/register", forged(index), attacker)).status, 429);
  assert.equal(sender.challenges.length, 1);
  const phone = phoneKey();
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phone, now)), { "x-client": "203.0.113.5" })).body.status, "challenge_sent", "the table still has room");
  // A challenge APNs could not take is not kept either.
  const failing = recorder({ challenge: "unavailable" });
  const flaky = await service({ sender: failing, now, challenges: createChallenges({ now, max: 1 }), clientAddressHeader: "X-Client" });
  assert.equal((await flaky("/v2/register", forged(10), { "x-client": "192.0.2.10" })).status, 502);
  assert.equal((await flaky("/v2/register", forged(11), { "x-client": "192.0.2.11" })).status, 502, "a second token finds room");
  assert.equal(failing.challenges.length, 2);
});

test("pre-verification limits count an IPv6 client by its /64", async () => {
  const now = clock();
  const post = await service({ sender: recorder(), now, clientAddressHeader: "X-Client" });
  for (let index = 0; index < 30; index++) assert.equal((await post("/v2/send", { forged: index }, { "x-client": `2001:db8:5:6::${index.toString(16)}` })).status, 403);
  assert.equal((await post("/v2/send", { forged: true }, { "x-client": "2001:db8:5:6:ffff::1" })).status, 429, "another address of the same /64");
  assert.equal((await post("/v2/send", { forged: true }, { "x-client": "2001:db8:5:7::1" })).status, 403, "the next /64 is another client");
});

test("v2: alert limits answer 429 before APNs, and one computer cannot spend another's approvals", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now, limits: { ...createLimits({ now }), tokenSends: createBuckets({ capacity: 62, refillMs: 24 * 3600_000, now }) } });
  const phone = phoneKey();
  await bind(post, sender, phone, now);
  for (let index = 0; index < 10; index++) assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: approval(`a${index}`) }))).status, 202);
  const capped = await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: approval("a10") }));
  assert.deepEqual(capped, { status: 429, body: { status: "rate_limited" }, retryAfter: "60" });
  assert.equal(sender.sends.length, 10);
  // Another computer of the same phone still reaches it.
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { by: hubB }), { by: hubB, event: approval("b0") }))).status, 202);
  // The token's daily budget: 62 - 11 used leaves 51, of which 50 are for approvals.
  const done = (eventId) => ({ kind: "done", eventId, sessionId: "managed_1" });
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { by: hubB }), { by: hubB, event: done("d0") }))).status, 202);
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { by: hubB }), { by: hubB, event: done("d1") }))).status, 429);
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { by: hubB }), { by: hubB, event: approval("b1") }))).status, 202);
  assert.equal(sender.sends.length, 13);
});

test("pre-verification limits: repeated failures and registers from one client wait", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now, clientAddressHeader: "X-Client", limits: { ...createLimits({ now }), registers: createBuckets({ capacity: 2, refillMs: 30_000, maxKeys: 10, now }) } });
  const from = (address) => ({ "x-client": address });
  for (let index = 0; index < 30; index++) assert.equal((await post("/v2/send", { forged: index }, from("198.51.100.1"))).status, 403);
  const blocked = await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)), from("198.51.100.1"));
  assert.deepEqual(blocked, { status: 429, body: { status: "rate_limited" }, retryAfter: "2" });
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)), from("198.51.100.2"))).status, 202);
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)), from("198.51.100.2"))).status, 202);
  assert.equal((await post("/v2/register", v2(now, "register", grantFor(phoneKey(), now)), from("198.51.100.2"))).status, 429);
});

test("v2: bindings survive a restart on the same state directory, which holds no token, computer or event", async () => {
  const now = clock();
  const directory = tempDirectory();
  const phone = phoneKey();
  const firstBindings = await openBindings({ directory, now });
  const first = recorder();
  await bind(await service({ sender: first, now, bindings: firstBindings }), first, phone, now);
  await firstBindings.close();
  const text = fileText(directory);
  for (const secret of ["ab".repeat(32), hubA.hub, "SHA256:", "managed_1", "attention", "sandbox", '"en"', "nonce"]) assert(!text.includes(secret), secret);

  const secondBindings = await openBindings({ directory, now });
  after(() => secondBindings.close());
  const second = recorder();
  const post = await service({ sender: second, now, bindings: secondBindings });
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now)))).status, 202);
  assert.equal(second.challenges.length, 0);
});

test("v2: a kind this service does not send is answered as unsupported, to the bound key only", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now });
  const phone = phoneKey();
  const later = { kind: "digest", eventId: "digest-1", sessionId: "managed_1" };
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: later }))).status, 403);
  await bind(post, sender, phone, now);
  assert.deepEqual(await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: later })), { status: 422, body: { status: "unsupported_kind" }, retryAfter: null });
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now), { event: { kind: "a kind", eventId: "e" } }))).status, 403, "still an identifier");
  assert.equal(sender.sends.length, 0);
});

test("v2: a phone that asked for approvals only is not sent agents' messages", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now });
  const phone = phoneKey();
  const subscription = subscriptionOf({ preference: "approvals" });
  await bind(post, sender, phone, now, { subscription });
  const message = { kind: "message", eventId: "notify:n.1", sessionId: "managed_1", notice: "n.1" };
  assert.deepEqual(await post("/v2/send", v2(now, "send", grantFor(phone, now, { subscription }), { subscription, event: message })), { status: 200, body: { status: "filtered" }, retryAfter: null });
  assert.equal(sender.sends.length, 0);
  assert.equal((await post("/v2/send", v2(now, "send", grantFor(phone, now, { subscription }), { subscription }))).status, 202, "its approvals still arrive");
  assert.equal(sender.sends.length, 1);
});

test("v1 lasts while an allowlist is set, padded or not; without one only v2 is served", async () => {
  const now = clock();
  const legacy = (operation) => signedBy(hubA, { ...baseMessage(), operation, issuedAt: seconds(now), event: operation === "send" ? baseMessage().event : null }, "dure-push-request-v1\0");
  for (const entry of [fingerprint, hubA.hub]) {
    const sender = recorder();
    const post = await service({ sender, now, allowedHubs: [entry] });
    assert.equal((await post("/v1/register", legacy("register"))).status, 200, entry);
    assert.equal((await post("/v1/send", legacy("send"))).status, 202, entry);
    assert.deepEqual(await post.health(), { status: 200, body: { status: "ready", api: [1, 2], kinds: ["approval", "done", "input", "message"] } });
  }
  const sender = recorder();
  const post = await service({ sender, now });
  assert.deepEqual(await post("/v1/register", legacy("register")), { status: 403, body: { status: "refused" }, retryAfter: null });
  assert.equal((await post("/v1/send", legacy("send"))).status, 403);
  assert.equal(sender.calls, 0);
  assert.deepEqual(await post.health(), { status: 200, body: { status: "ready", api: [2], kinds: ["approval", "done", "input", "message"] } });
  assert.throws(() => createPushServer({ sender, audiences: [AUDIENCE], allowedHubs: ["SHA256:short"] }), /fingerprint/);
});

test("v1: the per-token daily budget keeps its last alerts for approvals", async () => {
  const now = clock();
  const sender = recorder();
  const post = await service({ sender, now, allowedHubs: [fingerprint], limits: { ...createLimits({ now }), tokenSends: createBuckets({ capacity: 51, refillMs: 24 * 3600_000, now }) } });
  const alert = (kind, eventId) => signedBy(hubA, { ...baseMessage(), issuedAt: seconds(now), event: { kind, eventId } }, "dure-push-request-v1\0");
  assert.equal((await post("/v1/send", alert("done", "d0"))).status, 202);
  assert.equal((await post("/v1/send", alert("done", "d1"))).status, 429);
  assert.equal((await post("/v1/send", alert("approval", "a0"))).status, 202);
  assert.equal(sender.sends.length, 2);
});

test("startup refuses a missing or unwritable state directory and a missing audience, naming only the field", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyFile = path.join(fixtureRoot, "apns.p8");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  const notADirectory = path.join(fixtureRoot, "state-file");
  writeFileSync(notADirectory, "");
  const environment = { PATH: process.env.PATH, PORT: "8080", DURE_APNS_KEY_FILE: keyFile, DURE_APNS_KEY_ID: "TESTKEY123", DURE_APNS_TEAM_ID: "TESTTEAM12", DURE_PUSH_AUDIENCE: AUDIENCE, DURE_PUSH_STATE_DIR: tempDirectory() };
  const start = (change) => spawnSync(process.execPath, [new URL("./main.mjs", import.meta.url).pathname], { env: { ...environment, ...change }, encoding: "utf8", timeout: 10_000 });
  for (const [change, message] of [
    [{ DURE_PUSH_STATE_DIR: "" }, "DURE_PUSH_STATE_DIR is required"],
    [{ DURE_PUSH_STATE_DIR: notADirectory }, "DURE_PUSH_STATE_DIR is not writable"],
    [{ DURE_PUSH_AUDIENCE: "" }, "DURE_PUSH_AUDIENCE is required"],
    [{ DURE_PUSH_AUDIENCE: "http://push.example.org/" }, "Invalid push audience"],
    [{ DURE_PUSH_HUB_FINGERPRINTS: "SHA256:short" }, "Invalid authorized Hub fingerprint"],
  ]) {
    const run = start(change);
    assert.equal(run.status, 1, message);
    assert.equal(run.stderr, `Push service configuration failed: ${message}\n`);
  }
});

test("APNs answers that mean a token can never be delivered read as unregistered; other failures stay retryable", async () => {
  const answers = [];
  const apns = createHttp2Server();
  const sessions = [];
  apns.on("session", (session) => sessions.push(session));
  apns.on("stream", (stream) => {
    stream.resume();
    stream.on("end", () => {
      const [status, reason] = answers.shift();
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(JSON.stringify({ reason }));
    });
  });
  apns.listen(0, "127.0.0.1");
  await once(apns, "listening");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sender = createApnsSender({ key: privateKey.export({ type: "pkcs8", format: "pem" }), keyId: "TESTKEY123", teamId: "TESTTEAM12", openConnection: () => connect(`http://127.0.0.1:${apns.address().port}`) });
  try {
    for (const [answer, expected] of [
      [[410, "Unregistered"], "unregistered"],
      [[400, "BadDeviceToken"], "unregistered"],
      [[400, "DeviceTokenNotForTopic"], "unregistered"],
      [[400, "BadCollapseId"], "unavailable"],
      [[410, "ExpiredProviderToken"], "unavailable"],
      [[429, "TooManyRequests"], "unavailable"],
    ]) {
      answers.push(answer);
      assert.deepEqual(await sender.challenge(subscriptionOf(), { nonce: "0".repeat(32), key: "k.0123456789abcdef" }, "c".repeat(64)), { status: expected }, answer.join(" "));
      answers.push(answer);
      assert.deepEqual(await sender.send(baseMessage(), fingerprint), { status: expected }, answer.join(" "));
    }
  } finally {
    sender.close();
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => apns.close(resolve));
  }
});
