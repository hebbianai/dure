// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/test/setup";

let resolver = createRequire(import.meta.url);
let entry;
for (const name of ["dockview-react", "dockview", "dockview-core"]) {
  entry = resolver.resolve(name);
  resolver = createRequire(entry);
}
const root = resolve(dirname(entry), "../..");
const contract = "{ Droptarget, PointerDropTarget, DropTargetAnchorContainer, DockviewWillShowOverlayLocationEvent }";

function distribution(file) {
  const source = readFileSync(`${root}/dist/${file}`, "utf8");
  const module = { exports: {} };
  if (file.startsWith("package/")) {
    const exports = /^export \{[^}]*\};$/gm;
    if (file.endsWith(".mjs")) expect([...source.matchAll(exports)]).toHaveLength(1);
    // Expose the actual bundled private collaborators without replacing behavior.
    return new Function("exports", "module", `${source.replace(exports, "")}\nreturn ${contract};`)(module.exports, module);
  }
  const marker = "Object.defineProperty(exports, '__esModule', { value: true });";
  expect(source.split(marker)).toHaveLength(2);
  new Function("exports", "module", source.replace(marker, `exports.contract = ${contract};\n${marker}`))(module.exports, module);
  return module.exports.contract;
}

const formats = [
  {
    name: "CJS modules",
    ...resolver(`${root}/dist/cjs/dnd/droptarget.js`),
    ...resolver(`${root}/dist/cjs/dnd/pointer/pointerDropTarget.js`),
    ...resolver(`${root}/dist/cjs/dnd/dropTargetAnchorContainer.js`),
    ...resolver(`${root}/dist/cjs/dockview/events.js`),
  },
  ...["package/main.esm.mjs", "package/main.cjs.js", "dockview-core.js", "dockview-core.noStyle.js"].map((file) => ({ name: file, ...distribution(file) })),
];

afterEach(() => vi.restoreAllMocks());

function fixture(core, backend, mounting, options = {}) {
  const container = document.createElement("div"), content = document.createElement("section");
  container.append(content); document.body.append(container);
  const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
  const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 600));
  const anchor = new core.DropTargetAnchorContainer(container, { disabled: mounting === "relative" });
  const Target = backend === "html5" ? core.Droptarget : core.PointerDropTarget;
  const target = new Target(content, {
    acceptedTargetZones: ["left", "right", "top", "bottom"],
    canDisplayOverlay: () => true,
    getOverrideTarget: () => anchor.model,
    ...options,
  });
  return {
    container, content, target, width, height, rect,
    hover(x = 500, y = 560, consumed = false) {
      const event = new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.defineProperty(event, "dataTransfer", { value: { dropEffect: "none" } });
      if (consumed) Object.defineProperty(event, core.Droptarget.USED_EVENT_ID, { value: true });
      if (backend === "html5") content.dispatchEvent(event);
      else target._onDragOver({ clientX: x, clientY: y, pointerEvent: event });
    },
    retire() {
      if (backend === "html5") window.dispatchEvent(new MouseEvent("dragend"));
      else target._onDragLeave();
    },
    dispose() { target.dispose(); anchor.dispose(); container.remove(); },
  };
}

describe.each(formats)("installed $name drop owner", (core) => {
  it.each(["html5", "pointer"].flatMap((backend) => [{ type: "pixels", value: 24 }, { type: "pixels", value: 80 }, { type: "percentage", value: 20 }].map((activation) => ({ backend, activation }))))(
    "$backend chooses the nearest edge with $activation.type / $activation.value activation",
    ({ backend, activation }) => {
      const band = activation.type === "pixels" ? activation.value : 1000 * activation.value / 100;
      const verticalBand = activation.type === "pixels" ? activation.value : 600 * activation.value / 100;
      const f = fixture(core, backend, "absolute", {
        overlayModel: { activationSize: activation },
      });
      try {
        for (const x of [band - 1, band, band + 1, 1000 - band - 1, 1000 - band, 1000 - band + 1]) {
          f.hover(x, 5); expect(f.target.state).toBe("top");
          f.hover(x, 595); expect(f.target.state).toBe("bottom");
        }
        for (const y of [verticalBand - 1, verticalBand + 1, 600 - verticalBand - 1, 600 - verticalBand + 1]) {
          f.hover(5, y); expect(f.target.state).toBe("left");
          f.hover(995, y); expect(f.target.state).toBe("right");
        }
        // Equal distances keep the existing deterministic tie order.
        f.hover(5, 5); expect(f.target.state).toBe("left");
        f.hover(995, 595); expect(f.target.state).toBe("right");
        f.hover(500, 300); expect(f.target.state).toBeUndefined();
        const dropped = vi.fn();
        f.target.onDrop(dropped);
        f.hover(band - 1, 595);
        const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: band - 1, clientY: 595 });
        if (backend === "html5") f.content.dispatchEvent(drop);
        else f.target._onDropEvent({ pointerEvent: drop });
        expect(dropped).toHaveBeenCalledOnce();
        expect(dropped.mock.calls[0][0].position).toBe("bottom");
        expect(f.target.state).toBeUndefined();
        if (activation.type === "percentage") {
          f.height.mockReturnValue(100);
          f.rect.mockReturnValue(new DOMRect(0, 0, 1000, 100));
          // 6% from the left and 10% from the top: the top is closer in pixels.
          f.hover(60, 10); expect(f.target.state).toBe("top");
          f.hover(940, 90); expect(f.target.state).toBe("bottom");
        }
      } finally { f.dispose(); }
    },
  );

  it.each(["html5", "pointer"])("%s keeps accepted zones and center behavior on a narrow pane", (backend) => {
    const f = fixture(core, backend, "relative", {
      acceptedTargetZones: ["left", "right", "center"],
      overlayModel: { activationSize: { type: "pixels", value: 24 } },
    });
    try {
      f.width.mockReturnValue(40);
      f.height.mockReturnValue(100);
      f.rect.mockReturnValue(new DOMRect(0, 0, 40, 100));
      f.hover(21, 1); expect(f.target.state).toBe("right");
      f.hover(19, 1); expect(f.target.state).toBe("left");
      f.width.mockReturnValue(1000);
      f.rect.mockReturnValue(new DOMRect(0, 0, 1000, 100));
      f.hover(23, 1); expect(f.target.state).toBe("left");
      f.hover(24, 1); expect(f.target.state).toBe("center");
      f.hover(976, 1); expect(f.target.state).toBe("center");
      f.hover(977, 1); expect(f.target.state).toBe("right");
    } finally { f.dispose(); }
  });

  it.each(["html5", "pointer"].flatMap((backend) => ["relative", "absolute"].map((mounting) => ({ backend, mounting }))))(
    "$backend / $mounting publishes only the final accepted render",
    ({ backend, mounting }) => {
      const f = fixture(core, backend, mounting);
      let veto = false;
      const received = [], calls = [];
      f.target.onWillShowOverlay((event) => {
        calls.push("will");
        const projected = new core.DockviewWillShowOverlayLocationEvent(event, { kind: "content", getData: () => undefined });
        projected.onDidRenderOverlay((element) => {
          calls.push("rendered");
          expect(projected.defaultPrevented).toBe(false);
          expect(element.isConnected).toBe(true);
          expect(element.style.visibility).toBe("visible");
          expect(f.target.state).toBe(event.position);
          received.push({ element, position: event.position });
        });
      });
      f.target.onWillShowOverlay((event) => {
        calls.push("last-veto-opportunity");
        if (veto) event.preventDefault();
      });
      try {
        veto = true; f.hover();
        expect(received).toEqual([]);
        expect(f.container.querySelector(".dv-drop-target-selection, .dv-drop-target-anchor")).toBeNull();
        expect(f.target.state).toBeUndefined();
        calls.length = 0; veto = false; f.hover();
        expect(calls).toEqual(["will", "last-veto-opportunity", "rendered"]);
        expect(received).toHaveLength(1);
        const first = received[0].element;
        expect(received[0].position).toBe("bottom");
        calls.length = 0; f.hover();
        expect(calls).toEqual(["will", "last-veto-opportunity", "rendered"]);
        expect(received).toHaveLength(2);
        expect(received[1].element).toBe(first);
        f.hover(10, 300);
        expect(received).toHaveLength(3);
        expect(received[2]).toEqual({ position: "left", element: first });
        f.retire();
        expect(f.target.state).toBeUndefined();
        expect(first.isConnected).toBe(false);
        expect(received).toHaveLength(3);
        f.hover();
        expect(received).toHaveLength(4);
        expect(received[3].element).not.toBe(first);
        veto = true; f.hover();
        expect(received).toHaveLength(4);
        expect(f.target.state).toBeUndefined();
      } finally { f.dispose(); }
    },
  );

  it.each(["relative", "absolute"])("retires consumed %s state before measuring geometry", (mounting) => {
    const f = fixture(core, "html5", mounting);
    try {
      f.hover(); expect(f.target.state).toBe("bottom");
      f.width.mockClear(); f.height.mockClear(); f.rect.mockClear();
      f.hover(500, 560, true);
      expect({ width: f.width.mock.calls.length, height: f.height.mock.calls.length, rect: f.rect.mock.calls.length, state: f.target.state })
        .toEqual({ width: 0, height: 0, rect: 0, state: undefined });
    } finally { f.dispose(); }
  });
});
