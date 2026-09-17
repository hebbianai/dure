// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/. License: ../environment/device/LICENSE-agent-browser.

(async () => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) throw new Error("React DevTools hook not installed - relaunch with --enable react-devtools");
  const ri = hook.rendererInterfaces && hook.rendererInterfaces.get && hook.rendererInterfaces.get(1);
  if (!ri) throw new Error("No React renderer attached");

  const batches = await (async () => {
    const out = [];
    const origEmit = hook.emit;
    const emit = function (event, payload) {
      if (event === "operations") out.push(payload);
      return origEmit.apply(this, arguments);
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

  const boundaryMap = new Map();
  for (const ops of batches) decodeSuspenseOps(ops, boundaryMap);

  const results = [];
  for (const b of boundaryMap.values()) {
    if (b.parentID === 0) continue;
    const boundary = {
      id: b.id,
      parentID: b.parentID,
      name: b.name,
      isSuspended: b.isSuspended,
      environments: b.environments,
      suspendedBy: [],
      unknownSuspenders: null,
      owners: [],
      jsxSource: null,
    };
    if (ri.hasElementWithId(b.id)) {
      const displayName = ri.getDisplayNameForElementID(b.id);
      if (displayName) boundary.name = displayName;
      const result = ri.inspectElement(1, b.id, null, true);
      if (result && result.type === "full-data") {
        parseInspection(boundary, result.value);
      }
    }
    results.push(boundary);
  }
  return JSON.stringify(results);

  function decodeSuspenseOps(ops, map) {
    let i = 2;
    const strings = [null];
    const tableEnd = ++i + ops[i - 1];
    while (i < tableEnd) {
      const len = ops[i++];
      strings.push(String.fromCodePoint(...ops.slice(i, i + len)));
      i += len;
    }
    while (i < ops.length) {
      const op = ops[i];
      if (op === 1) {
        const type = ops[i + 2];
        i += 3 + (type === 11 ? 4 : 5);
      } else if (op === 2) {
        i += 2 + ops[i + 1];
      } else if (op === 3) {
        i += 3 + ops[i + 2];
      } else if (op === 4) {
        i += 3;
      } else if (op === 5) {
        i += 4;
      } else if (op === 6) {
        i++;
      } else if (op === 7) {
        i += 3;
      } else if (op === 8) {
        const id = ops[i + 1];
        const parentID = ops[i + 2];
        const nameStrID = ops[i + 3];
        const isSuspended = ops[i + 4] === 1;
        const numRects = ops[i + 5];
        i += 6;
        if (numRects !== -1) i += numRects * 4;
        map.set(id, { id, parentID, name: strings[nameStrID] || null, isSuspended, environments: [] });
      } else if (op === 9) {
        i += 2 + ops[i + 1];
      } else if (op === 10) {
        i += 3 + ops[i + 2];
      } else if (op === 11) {
        const numRects = ops[i + 2];
        i += 3;
        if (numRects !== -1) i += numRects * 4;
      } else if (op === 12) {
        i++;
        const changeLen = ops[i++];
        for (let c = 0; c < changeLen; c++) {
          const id = ops[i++];
          i++;
          i++;
          const isSuspended = ops[i++] === 1;
          const envLen = ops[i++];
          const envs = [];
          for (let e = 0; e < envLen; e++) {
            const n = strings[ops[i++]];
            if (n != null) envs.push(n);
          }
          const node = map.get(id);
          if (node) {
            node.isSuspended = isSuspended;
            for (const env of envs) {
              if (!node.environments.includes(env)) node.environments.push(env);
            }
          }
        }
      } else if (op === 13) {
        i += 2;
      } else {
        i++;
      }
    }
  }

  function parseInspection(boundary, data) {
    const rawSuspendedBy = data.suspendedBy;
    const rawSuspenders = Array.isArray(rawSuspendedBy)
      ? rawSuspendedBy
      : rawSuspendedBy && Array.isArray(rawSuspendedBy.data) ? rawSuspendedBy.data : null;
    if (rawSuspenders) {
      for (const entry of rawSuspenders) {
        const awaited = entry && entry.awaited;
        if (!awaited) continue;
        const desc = preview(awaited.description) || preview(awaited.value);
        boundary.suspendedBy.push({
          name: awaited.name || "unknown",
          description: desc,
          duration: awaited.end && awaited.start ? Math.round(awaited.end - awaited.start) : 0,
          env: awaited.env || (entry && entry.env) || null,
          ownerName: (awaited.owner && awaited.owner.displayName) || null,
          ownerStack: parseStack((awaited.owner && awaited.owner.stack) || awaited.stack),
          awaiterName: (entry && entry.owner && entry.owner.displayName) || null,
          awaiterStack: parseStack((entry && entry.owner && entry.owner.stack) || (entry && entry.stack)),
        });
      }
    }
    if (data.unknownSuspenders && data.unknownSuspenders !== 0) {
      const reasons = {
        1: "production build (no debug info)",
        2: "old React version (missing tracking)",
        3: "thrown Promise (library using throw instead of use())",
      };
      boundary.unknownSuspenders = reasons[data.unknownSuspenders] || "unknown reason";
    }
    if (Array.isArray(data.owners)) {
      for (const o of data.owners) {
        if (o && o.displayName) {
          const src = Array.isArray(o.stack) && o.stack.length > 0 && Array.isArray(o.stack[0])
            ? [o.stack[0][1] || "(unknown)", o.stack[0][2], o.stack[0][3]]
            : null;
          boundary.owners.push({ name: o.displayName, env: o.env || null, source: src });
        }
      }
    }
    if (Array.isArray(data.stack) && data.stack.length > 0) {
      const frame = data.stack[0];
      if (Array.isArray(frame) && frame.length >= 4) {
        boundary.jsxSource = [frame[1] || "(unknown)", frame[2], frame[3]];
      }
    }
  }

  function parseStack(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw
      .filter((f) => Array.isArray(f) && f.length >= 4)
      .map((f) => [f[0] || "", f[1] || "", f[2] || 0, f[3] || 0]);
  }

  function preview(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v !== "object") return String(v);
    if (typeof v.preview_long === "string") return v.preview_long;
    if (typeof v.preview_short === "string") return v.preview_short;
    if (typeof v.value === "string") return v.value;
    try {
      const s = JSON.stringify(v);
      return s.length > 80 ? s.slice(0, 77) + "..." : s;
    } catch {
      return "";
    }
  }
})()
