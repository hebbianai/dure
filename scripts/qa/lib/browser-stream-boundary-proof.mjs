import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

function pageSocketProbe(url, message) {
  return `new Promise(resolve => {
    const socket = new WebSocket(${JSON.stringify(url)});
    const timer = setTimeout(() => {socket.close(); resolve('timeout');}, 3000);
    socket.onerror = () => {clearTimeout(timer); resolve('rejected');};
    socket.onopen = () => {
      ${message ? `socket.send(${JSON.stringify(JSON.stringify(message))});` : ""}
      setTimeout(() => {socket.close(); clearTimeout(timer); resolve('accepted');}, 100);
    };
  })`;
}

async function openCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let identifier = 0;
  let onEvent = () => {};
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("CDP connection timeout"));
    }, 5000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("CDP connection failed"));
      },
      { once: true },
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      onEvent(message);
      return;
    }
    const operation = pending.get(message.id);
    if (!operation) return;
    clearTimeout(operation.timer);
    pending.delete(message.id);
    if (message.error)
      operation.reject(new Error(JSON.stringify(message.error)));
    else operation.resolve(message.result);
  });
  function request(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++identifier;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  return {
    request,
    events(callback) {
      onEvent = callback;
    },
    close() {
      socket.close();
      for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(new Error("CDP probe closed"));
      }
      pending.clear();
    },
  };
}

export async function proveBrowserStreamBoundary({
  command,
  port,
  identity,
  artifacts,
  publishFrame,
  observe,
}) {
  const rawUrl = `ws://127.0.0.1:${port}/`;
  await command("a", ["fill", 'input[aria-label="Name"]', ""]);
  await command("a", ["focus", 'input[aria-label="Name"]']);
  const attempt = (
    await command("b", [
      "eval",
      pageSocketProbe(rawUrl, {
        type: "input_keyboard",
        eventType: "char",
        text: "X",
      }),
    ])
  ).data.result;
  const value = (
    await command("a", ["get", "value", 'input[aria-label="Name"]'])
  ).data.value;
  const rawStream = {
    connection: attempt,
    value,
    injected: value === "X",
    isolated: attempt === "rejected" && value === "",
  };
  await command("a", ["stream", "disable"]);
  const disabled = await command("a", ["stream", "status"]);
  const afterDisable = (await command("b", ["eval", pageSocketProbe(rawUrl)]))
    .data.result;
  assert.equal(afterDisable, "rejected");
  const cdpUrl = (await command("a", ["get", "cdp-url"])).data.cdpUrl;
  const bound = (await command("a", ["tab", "list"])).data.tabs.filter(
    (tab) => tab.active,
  );
  assert.equal(
    bound.length,
    1,
    "engine must expose exactly one active binding",
  );
  const targetId = bound[0].targetId;
  const directCdp = (await command("b", ["eval", pageSocketProbe(cdpUrl)])).data
    .result;
  assert.equal(directCdp, "rejected");
  const cdp = await openCdp(cdpUrl);
  try {
    const pages = (await cdp.request("Target.getTargets")).targetInfos.filter(
      (target) => target.type === "page",
    );
    assert.ok(
      pages.some((page) => page.targetId === targetId),
      "bound engine target must still exist",
    );
    const { sessionId } = await cdp.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const observed = await cdp.request(
      "Runtime.evaluate",
      { expression: "window.fixture.instance", returnByValue: true },
      sessionId,
    );
    assert.equal(observed.result.value, identity);
    let bulkCharEvent;
    try {
      await cdp.request(
        "Input.dispatchKeyEvent",
        { type: "char", text: "한글 조합 검증" },
        sessionId,
      );
      bulkCharEvent = { accepted: true };
    } catch (error) {
      bulkCharEvent = { accepted: false, error: error.message };
    }
    let frame;
    let sequence = 0;
    let delivery = Promise.resolve();
    let deliveryError;
    cdp.events((event) => {
      if (
        event.method === "Page.screencastFrame" &&
        event.sessionId === sessionId
      ) {
        frame = event.params;
        const current = frame;
        delivery = (
          publishFrame
            ? publishFrame({
                sequence: ++sequence,
                data: current.data,
                metadata: current.metadata,
              })
            : Promise.resolve()
        )
          .then(() =>
            cdp.request(
              "Page.screencastFrameAck",
              { sessionId: current.sessionId },
              sessionId,
            ),
          )
          .catch((error) => {
            deliveryError = error;
          });
      }
    });
    await cdp.request(
      "Page.startScreencast",
      { format: "jpeg", quality: 80, maxWidth: 1000, maxHeight: 750 },
      sessionId,
    );
    await command("a", [
      "fill",
      'input[aria-label="Name"]',
      "Host stream candidate",
    ]);
    const deadline = Date.now() + 5000;
    while (!frame) {
      if (Date.now() > deadline)
        throw new Error("CDP screencast did not produce a frame");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await delivery;
    if (deliveryError) throw deliveryError;
    const viewer = observe ? await observe() : undefined;
    if (deliveryError) throw deliveryError;
    await writeFile(
      join(artifacts, "cdp-stream.jpg"),
      Buffer.from(frame.data, "base64"),
    );
    await cdp.request("Page.stopScreencast", {}, sessionId);
    return {
      rawStream,
      disabledStatus: disabled.data,
      afterDisable,
      directCdp,
      bulkCharEvent,
      viewer,
      cdpScreencast: { samePage: true, targetId, metadata: frame.metadata },
      limitation:
        "No Dure Host authorization or handoff is implemented by this probe.",
    };
  } finally {
    cdp.close();
  }
}
