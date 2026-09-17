// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/. License: ../environment/device/LICENSE-agent-browser.

(async () => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) throw new Error("React DevTools hook not installed - relaunch with --enable react-devtools");
  const ri = hook.rendererInterfaces && hook.rendererInterfaces.get && hook.rendererInterfaces.get(1);
  if (!ri) throw new Error("No React renderer attached - the page has not booted React yet");

  const batches = await (async () => {
    const out = [];
    const origEmit = hook.emit;
    const emit = function (event, payload) {
      if (event === "operations") out.push(Array.from(payload));
      return origEmit.apply(hook, arguments);
    };
    hook.emit = emit;
    try {
      ri.flushInitialOperations();
      await new Promise(resolve => setTimeout(resolve, 50));
      return out;
    } finally {
      if (hook.emit === emit) hook.emit = origEmit;
    }
  })();

  const nodes = batches.flatMap((ops) => {
    let i = 2;
    const strings = [null];
    const tableEnd = ++i + ops[i - 1];
    while (i < tableEnd) {
      const len = ops[i++];
      strings.push(String.fromCodePoint(...ops.slice(i, i + len)));
      i += len;
    }
    const out = [];
    while (i < ops.length) {
      const op = ops[i];
      if (op === 1) {
        const id = ops[i + 1];
        const type = ops[i + 2];
        i += 3;
        if (type === 11) {
          out.push({ id, type, name: null, key: null, parent: 0 });
          i += 4;
        } else {
          out.push({
            id,
            type,
            name: strings[ops[i + 2]] || null,
            key: strings[ops[i + 3]] || null,
            parent: ops[i],
          });
          i += 5;
        }
      } else {
        i += skip(op, ops, i);
      }
    }
    return out;

    function skip(op, ops, i) {
      if (op === 2) return 2 + ops[i + 1];
      if (op === 3) return 3 + ops[i + 2];
      if (op === 4) return 3;
      if (op === 5) return 4;
      if (op === 6) return 1;
      if (op === 7) return 3;
      if (op === 8) return 6 + rects(ops[i + 5]);
      if (op === 9) return 2 + ops[i + 1];
      if (op === 10) return 3 + ops[i + 2];
      if (op === 11) return 3 + rects(ops[i + 2]);
      if (op === 12) return suspenders(ops, i);
      if (op === 13) return 2;
      return 1;
    }
    function rects(n) {
      return n === -1 ? 0 : n * 4;
    }
    function suspenders(ops, i) {
      let j = i + 2;
      for (let c = 0; c < ops[i + 1]; c++) j += 5 + ops[j + 4];
      return j - i;
    }
  });

  return JSON.stringify(nodes);
})()
