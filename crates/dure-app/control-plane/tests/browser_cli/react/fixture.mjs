import React, { createElement as h, Suspense, use, useEffect, useState } from "react";

let resolvePending;
const pending = new Promise(resolve => { resolvePending = resolve; });

function PendingMessage() {
  return h("p", { id: "resolved" }, use(pending));
}

function Counter({ label }) {
  const [count, setCount] = useState(0);
  useEffect(() => { window.reactFixtureReady = React.version; }, []);
  return h("button", { id: "increment", onClick: () => setCount(value => value + 1) }, `${label}: ${count}`);
}

export function App() {
  const [showPending, setShowPending] = useState(false);
  return h("main", null,
    h(Counter, { label: "한글 counter" }),
    h("button", { id: "suspend", onClick: () => setShowPending(true) }, "Suspend"),
    h("button", { id: "resolve", onClick: () => resolvePending("Resolved 한글") }, "Resolve"),
    h(Suspense, { fallback: h("p", { id: "pending" }, "Waiting") },
      showPending ? h(PendingMessage) : h("p", { id: "static" }, "Ready")),
  );
}

export { h };
