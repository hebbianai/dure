import { createHash, createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";
import { en } from "../src/locales/en.ts";
import { ko } from "../src/locales/ko.ts";

const TOPIC = "dev.hebbian.ide.mobile";
/** `PUSH_APPROVAL_CATEGORY` and `PUSH_REPLY_CATEGORY` in dure-hub-protocol: the phone registers their actions. */
const APPROVAL_CATEGORY = "dure.approval";
const REPLY_CATEGORY = "dure.reply";
const BODY = {
  approval: "notifications.push.approvalBody",
  done: "notifications.push.doneBody",
  input: "notifications.push.inputBody",
};
const ENDPOINTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

export function createApnsSender({ key, keyId, teamId, openConnection = connect, now = Date.now }) {
  const privateKey = createPrivateKey(key);
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APNs requires a P-256 signing key");
  }
  if (!/^[A-Z0-9]{10}$/.test(keyId) || !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("Invalid APNs key or team identifier");
  }
  const connections = new Map();
  let jwt;
  let issuedAt = 0;
  const token = () => {
    const seconds = Math.floor(now() / 1000);
    if (!jwt || seconds - issuedAt >= 2400 || seconds < issuedAt) {
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const content = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: seconds })}`;
      const signature = sign("sha256", Buffer.from(content), { key: privateKey, dsaEncoding: "ieee-p1363" });
      jwt = `${content}.${signature.toString("base64url")}`;
      issuedAt = seconds;
    }
    return jwt;
  };
  const connection = (environment) => {
    let session = connections.get(environment);
    if (!session || session.closed || session.destroyed) {
      session = openConnection(ENDPOINTS[environment]);
      // Request streams report the actual failure; never log headers/tokens.
      session.on("error", () => {});
      session.on("goaway", () => {
        if (connections.get(environment) === session) connections.delete(environment);
        session.close();
      });
      connections.set(environment, session);
    }
    return session;
  };

  return {
    send(message, sender) {
      const { subscription, event } = message;
      const catalog = subscription.language === "ko" ? ko : en;
      // Beside the generic text, only identifiers (`PushAlertContext` in
      // dure-hub-protocol): the agent a tap opens, what happened, the
      // computer that raised it — as the phone's paired entry names it,
      // unpadded — and, for an approval or a finished turn the phone can
      // answer, that approval or process. Never what was asked or said: the
      // phone's notification service reads that from the computer itself
      // (`mutable-content`) and keeps this text when it cannot.
      const approval = event.approval && event.sessionId ? event.approval : undefined;
      const reply = event.reply && event.sessionId ? event.reply : undefined;
      const category = approval ? APPROVAL_CATEGORY : reply ? REPLY_CATEGORY : undefined;
      const body = JSON.stringify({
        aps: {
          alert: { title: "Dure", body: catalog[BODY[event.kind]] },
          sound: "default",
          ...(category ? { category } : {}),
          ...(event.sessionId ? { "mutable-content": 1 } : {}),
        },
        ...(event.sessionId ? { dure: {
          session: event.sessionId,
          kind: event.kind,
          hub: sender.replace(/=+$/, ""),
          ...(approval ? { approval } : {}),
          ...(reply ? { reply } : {}),
        } } : {}),
      });
      return new Promise((resolve) => {
        let request;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(result);
        };
        // A total deadline also bounds a provider that keeps a stream active
        // without finishing its response. An inactivity timeout cannot do that.
        const deadline = setTimeout(() => {
          finish({ status: "unavailable" });
          request?.close();
        }, 7000);
        try {
          request = connection(subscription.environment).request({
            ":method": "POST",
            ":path": `/3/device/${subscription.token}`,
            authorization: `bearer ${token()}`,
            "apns-topic": TOPIC,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(now() / 1000) + 300),
            "apns-collapse-id": createHash("sha256").update(`${sender}\0${event.eventId}`).digest("hex"),
            "content-type": "application/json",
          });
        } catch {
          finish({ status: "unavailable" });
          return;
        }
        let status;
        let bytes = 0;
        let response = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => { status = headers[":status"]; });
        request.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 4096) {
            finish({ status: "unavailable" });
            request.close();
          } else response += chunk;
        });
        request.on("error", () => finish({ status: "unavailable" }));
        request.on("end", () => {
          if (status === 200) finish({ status: "accepted" });
          else {
            let reason;
            try { reason = JSON.parse(response).reason; } catch { /* Provider failure stays explicit. */ }
            finish({ status: status === 410 && reason === "Unregistered" ? "unregistered" : "unavailable" });
          }
        });
        request.on("close", () => finish({ status: "unavailable" }));
        request.end(body);
      });
    },
    close() {
      for (const session of connections.values()) session.destroy();
      connections.clear();
    },
  };
}
