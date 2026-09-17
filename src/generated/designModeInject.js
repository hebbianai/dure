var __DureDesignModeBundle = (function(exports) {
  "use strict";
  const MAX_CONTEXT_TEXT = 240;
  function trimText(value, max = MAX_CONTEXT_TEXT) {
    const collapsed = (value ?? "").replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
  }
  function labelledByText(element) {
    const ids = element.getAttribute("aria-labelledby");
    if (!ids) return "";
    const doc = element.ownerDocument;
    return trimText(
      ids.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ")
    );
  }
  function elementAccessibility(element) {
    const ariaLabel = element.getAttribute("aria-label") ?? void 0;
    const ariaLabelledBy = element.getAttribute("aria-labelledby") ?? void 0;
    const role = element.getAttribute("role") ?? void 0;
    const fallback = ariaLabel || labelledByText(element) || element.getAttribute("alt") || element.getAttribute("title") || trimText(element.textContent);
    const accessibility = {};
    if (role) accessibility.role = role;
    if (ariaLabel) accessibility.ariaLabel = ariaLabel;
    if (ariaLabelledBy) accessibility.ariaLabelledBy = ariaLabelledBy;
    const name = trimText(fallback);
    if (name) accessibility.accessibleName = name;
    return accessibility;
  }
  function elementSelector(element, maxDepth = 5) {
    if (element.id) return `#${element.id}`;
    const parts = [];
    let current = element;
    while (current && parts.length < maxDepth) {
      const tag = current.tagName.toLowerCase();
      if (tag === "body" || tag === "html") break;
      if (current.id) {
        parts.unshift(`#${current.id}`);
        break;
      }
      const parent = current.parentElement;
      const sameTag = parent ? Array.from(parent.children).filter(
        (child) => child.tagName === current?.tagName
      ) : [];
      const index = sameTag.indexOf(current) + 1;
      const classes = Array.from(current.classList).slice(0, 2);
      const classPart2 = classes.length > 0 ? `.${classes.join(".")}` : "";
      parts.unshift(
        sameTag.length > 1 ? `${tag}${classPart2}:nth-of-type(${index})` : `${tag}${classPart2}`
      );
      current = parent;
    }
    return parts.join(" > ");
  }
  function ancestorPath(element, maxDepth = 6) {
    const path = [];
    let current = element.parentElement;
    while (current && path.length < maxDepth) {
      const tag = current.tagName.toLowerCase();
      if (tag === "body" || tag === "html") break;
      const classes = Array.from(current.classList).slice(0, 2);
      path.unshift(`${tag}${classes.length ? `.${classes.join(".")}` : ""}`);
      current = current.parentElement;
    }
    return path;
  }
  function nearbyText(element, limit = 3) {
    const parent = element.parentElement;
    if (!parent) return [];
    const texts = [];
    for (const sibling of Array.from(parent.children)) {
      if (sibling === element) continue;
      const text = trimText(sibling.textContent, 80);
      if (text) texts.push(text);
      if (texts.length >= limit) break;
    }
    return texts;
  }
  function selectedTextWithin(element) {
    const selection = element.ownerDocument.defaultView?.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
      return void 0;
    const text = trimText(selection.toString());
    if (!text) return void 0;
    const anchor = selection.anchorNode;
    if (anchor && !element.contains(
      anchor.nodeType === 1 ? anchor : anchor.parentElement
    )) {
      return void 0;
    }
    return text;
  }
  function reactComponentName(element) {
    const key = Object.keys(element).find(
      (name) => name.startsWith("__reactFiber$")
    );
    if (!key) return void 0;
    let fiber = element[key];
    for (let depth = 0; fiber && depth < 8; depth += 1) {
      const type = fiber.type;
      if (type && typeof type !== "string") {
        const name = type.displayName ?? type.name;
        if (name && /^[A-Z]/.test(name)) return name;
      }
      fiber = fiber.return;
    }
    return void 0;
  }
  function pageContext(view, now) {
    return {
      url: view.location.href,
      title: view.document.title,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
      scrollX: Math.round(view.scrollX),
      scrollY: Math.round(view.scrollY),
      devicePixelRatio: view.devicePixelRatio,
      capturedAt: now
    };
  }
  const CAPTURED_CSS_PROPERTIES = [
    "display",
    "position",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "margin",
    "padding",
    "gap",
    "flex-direction",
    "align-items",
    "justify-content",
    "flex",
    "grid-template-columns",
    "color",
    "background-color",
    "border",
    "border-radius",
    "box-shadow",
    "outline",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-decoration",
    "opacity",
    "overflow",
    "z-index",
    "transform",
    "transition"
  ];
  const NOISE_VALUES = /* @__PURE__ */ new Set([
    "",
    "none",
    "normal",
    "auto",
    "0px",
    "0px 0px",
    "0%",
    "rgba(0, 0, 0, 0)",
    "transparent"
  ]);
  const DEFAULT_HTML_LIMIT_BYTES = 4e3;
  function classPart(element) {
    const classes = Array.from(element.classList).slice(0, 2);
    return classes.length > 0 ? `.${classes.join(".")}` : "";
  }
  function elementLabel(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    return `${tag}${classPart(element)}${id}`;
  }
  function elementPath(element, maxDepth = 4) {
    const parts = [];
    let current = element;
    while (current && parts.length < maxDepth) {
      if (current.tagName.toLowerCase() === "body") break;
      parts.unshift(elementLabel(current));
      current = current.parentElement;
    }
    return parts.join(" > ");
  }
  function capturedCss(style, properties = CAPTURED_CSS_PROPERTIES) {
    const css = {};
    for (const property of properties) {
      const value = style.getPropertyValue(property)?.trim() ?? "";
      if (NOISE_VALUES.has(value)) continue;
      css[property] = value;
    }
    return css;
  }
  function openingTag(element) {
    const attributes = Array.from(element.attributes).map((attribute) => ` ${attribute.name}="${attribute.value}"`).join("");
    return `<${element.tagName.toLowerCase()}${attributes}>`;
  }
  function elideHtml(input) {
    const limit = input.limitBytes ?? DEFAULT_HTML_LIMIT_BYTES;
    if (byteLength(input.html) <= limit) {
      return { html: input.html, elided: false };
    }
    const body = input.childCount > 0 ? `
  <!-- ${input.childCount} child element(s) elided -->
` : "\n  <!-- content elided -->\n";
    return {
      html: `${input.openingTag}${body}</${input.tagName}>`,
      elided: true
    };
  }
  function capturedHtml(element, limitBytes = DEFAULT_HTML_LIMIT_BYTES) {
    return elideHtml({
      html: element.outerHTML,
      childCount: element.children.length,
      tagName: element.tagName.toLowerCase(),
      openingTag: openingTag(element),
      limitBytes
    });
  }
  function byteLength(text) {
    return typeof TextEncoder === "function" ? new TextEncoder().encode(text).byteLength : text.length;
  }
  function captureElement(element, options = {}) {
    const readStyle = options.readStyle ?? ((target) => window.getComputedStyle(target));
    const box = element.getBoundingClientRect();
    const { html, elided } = capturedHtml(element, options.limitBytes);
    const source = element.getAttribute("data-dure-src") ?? void 0;
    const view = element.ownerDocument.defaultView;
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    const selectedText = selectedTextWithin(element);
    const component = reactComponentName(element);
    return {
      label: elementLabel(element),
      path: elementPath(element),
      selector: elementSelector(element),
      ancestors: ancestorPath(element),
      nearby: nearbyText(element),
      accessibility: elementAccessibility(element),
      html,
      htmlElided: elided,
      css: capturedCss(readStyle(element)),
      rect: {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height)
      },
      pageRect: {
        x: Math.round(box.left + scrollX),
        y: Math.round(box.top + scrollY),
        width: Math.round(box.width),
        height: Math.round(box.height)
      },
      ...view && options.now ? { page: pageContext(view, options.now) } : {},
      ...source ? { source } : {},
      ...selectedText ? { selectedText } : {},
      ...component ? { component } : {}
    };
  }
  function normalizePickTarget(element) {
    const svg = element.closest("svg");
    return svg ?? element;
  }
  function isPickableTarget(element) {
    const excluded = element.closest(
      ".xterm-screen, .xterm-rows, .cm-content, .cm-gutters"
    );
    return excluded === null;
  }
  const DESIGN_MODE_MESSAGE = "dure:design-mode:capture:v1";
  function captureEnvelope(nonce, kind, body) {
    return { type: DESIGN_MODE_MESSAGE, nonce, kind, body };
  }
  const HASH_CHUNK_LIMIT = 1200;
  const HASH_PREFIX = "dure-dm";
  function encodeHashChunks(nonce, payload, limit = HASH_CHUNK_LIMIT) {
    const encoded = encodeURIComponent(payload);
    const total = Math.max(1, Math.ceil(encoded.length / limit));
    const chunks = [];
    for (let index = 0; index < total; index += 1) {
      const data = encoded.slice(index * limit, (index + 1) * limit);
      chunks.push(`${HASH_PREFIX}:${nonce}:${index}:${total}:${data}`);
    }
    return chunks;
  }
  const HOST_ID = "dure-design-mode-overlay";
  const OVERLAY_CSS = `
:host { all: initial; }
.root {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  pointer-events: none;
}
.box {
  position: fixed;
  border: 1px solid rgba(59, 130, 246, 0.9);
  background: rgba(59, 130, 246, 0.14);
  pointer-events: none;
  transition: all 60ms linear;
}
.label {
  position: fixed;
  padding: 2px 6px;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #fff;
  background: rgba(37, 99, 235, 0.95);
  border-radius: 3px;
  pointer-events: none;
  white-space: nowrap;
}
.backdrop {
  position: fixed;
  inset: 0;
  pointer-events: auto;
}
.menu {
  position: fixed;
  min-width: 176px;
  padding: 4px;
  font: 12px/1.5 -apple-system, system-ui, sans-serif;
  color: #e5e5e5;
  background: rgba(23, 23, 23, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}
.item {
  display: block;
  width: 100%;
  padding: 5px 8px;
  text-align: left;
  color: inherit;
  background: none;
  border: 0;
  border-radius: 5px;
  font: inherit;
  cursor: pointer;
}
.item:hover { background: rgba(255, 255, 255, 0.1); }
.sep { height: 1px; margin: 4px 2px; background: rgba(255, 255, 255, 0.12); }
`;
  function startDesignModePicker(callbacks) {
    const host = document.createElement("div");
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    const root = document.createElement("div");
    root.className = "root";
    const box = document.createElement("div");
    box.className = "box";
    const label = document.createElement("div");
    label.className = "label";
    root.append(box, label);
    shadow.append(style, root);
    document.body.append(host);
    let hovered = null;
    let depthOffset = 0;
    let stopped = false;
    let menuParts = null;
    const targetFromHover = () => {
      let element = hovered;
      for (let step = 0; step < depthOffset && element?.parentElement; step += 1) {
        const parent = element.parentElement;
        if (parent === document.body) break;
        element = parent;
      }
      return element;
    };
    const targetAt = (x, y) => {
      host.style.display = "none";
      const found = document.elementFromPoint(x, y);
      host.style.display = "";
      if (!found || found === document.documentElement || found === document.body) {
        return null;
      }
      if (!isPickableTarget(found)) return null;
      return normalizePickTarget(found);
    };
    const paint = (element) => {
      if (!element) {
        box.style.display = "none";
        label.style.display = "none";
        return;
      }
      const rect = element.getBoundingClientRect();
      box.style.display = "";
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      label.style.display = "";
      label.textContent = `${element.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
      const above = rect.top - 18;
      label.style.left = `${Math.max(2, rect.left)}px`;
      label.style.top = `${above > 2 ? above : rect.top + 2}px`;
    };
    const closeMenu = () => {
      menuParts?.backdrop.remove();
      menuParts?.menu.remove();
      menuParts = null;
    };
    const pick = (element, intent) => {
      const captured = captureElement(element, { now: (/* @__PURE__ */ new Date()).toISOString() });
      stop();
      callbacks.onPick(captured, element, intent);
    };
    const openMenu = (x, y, element) => {
      closeMenu();
      const backdrop = document.createElement("div");
      backdrop.className = "backdrop";
      backdrop.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      });
      const menu = document.createElement("div");
      menu.className = "menu";
      const item = (text, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "item";
        button.textContent = text;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action();
        });
        return button;
      };
      const separator = document.createElement("div");
      separator.className = "sep";
      menu.append(
        item("Type into agent prompt", () => pick(element, "send")),
        item("Copy to clipboard", () => pick(element, "copy")),
        separator,
        item("Exit Pinpoint", () => {
          stop();
          callbacks.onCancel?.();
        })
      );
      root.append(backdrop, menu);
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.min(x, Math.max(0, window.innerWidth - rect.width - 4))}px`;
      menu.style.top = `${Math.min(y, Math.max(0, window.innerHeight - rect.height - 4))}px`;
      menuParts = { backdrop, menu };
    };
    const onMove = (event) => {
      if (menuParts) return;
      const next = targetAt(event.clientX, event.clientY);
      if (next !== hovered) {
        hovered = next;
        depthOffset = 0;
      }
      paint(targetFromHover());
    };
    const onContextMenu = (event) => {
      const element = targetFromHover() ?? targetAt(event.clientX, event.clientY);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.clientX, event.clientY, element);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (menuParts) {
          closeMenu();
          return;
        }
        stop();
        callbacks.onCancel?.();
        return;
      }
      if (menuParts) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (!hovered) return;
        event.preventDefault();
        depthOffset = event.key === "ArrowUp" ? depthOffset + 1 : Math.max(0, depthOffset - 1);
        paint(targetFromHover());
      }
    };
    function stop() {
      if (stopped) return;
      stopped = true;
      closeMenu();
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("keydown", onKeyDown, true);
      host.remove();
    }
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("keydown", onKeyDown, true);
    return { stop };
  }
  const GLOBAL = "__DURE_DESIGN_MODE__";
  function injectedConfig() {
    const config = window.__DURE_DESIGN_MODE_CONFIG__;
    if (!config?.nonce) return void 0;
    return config;
  }
  function sendViaHash(config, payload) {
    const chunks = encodeHashChunks(config.nonce, payload);
    let index = 0;
    const step = () => {
      if (index >= chunks.length) return;
      location.hash = chunks[index];
      index += 1;
      setTimeout(step, 120);
    };
    step();
  }
  let handle = null;
  function report(kind, body) {
    const config = injectedConfig();
    if (!config) {
      console.error(
        "[dure design mode] no injection config — the app did not plant a nonce"
      );
      return;
    }
    sendViaHash(
      config,
      JSON.stringify(captureEnvelope(config.nonce, kind, body))
    );
  }
  const api = {
    start: () => {
      if (handle) return false;
      handle = startDesignModePicker({
        onPick: (captured, _element, intent) => {
          handle = null;
          report("pick", { captured, intent });
        },
        onCancel: () => {
          handle = null;
          report("cancel", { reason: "user" });
        }
      });
      return true;
    },
    stop: () => {
      handle?.stop();
      handle = null;
    },
    active: () => handle !== null,
    probe: () => ({
      version: 1,
      ipc: Boolean(injectedConfig()),
      active: handle !== null
    })
  };
  function install() {
    if (injectedConfig()) {
      if (document.readyState !== "loading") {
        report("cancel", { reason: "navigation" });
      } else {
        window.addEventListener("DOMContentLoaded", () => {
          report("cancel", { reason: "navigation" });
        });
      }
      window[GLOBAL] = api;
    }
    const qaTarget = injectedConfig()?.qaAutoPick;
    if (qaTarget) {
      const attempt = (remaining) => {
        const element = document.querySelector(qaTarget);
        if (!element) {
          if (remaining <= 0) {
            report("error", { reason: `qa_target_not_found: ${qaTarget}` });
            return;
          }
          setTimeout(() => attempt(remaining - 1), 200);
          return;
        }
        report("pick", {
          captured: captureElement(element, { now: (/* @__PURE__ */ new Date()).toISOString() })
        });
      };
      setTimeout(() => attempt(10), 300);
    }
  }
  function captureAtPoint(point) {
    const candidate = point ? document.elementFromPoint(point.x, point.y) : document.activeElement;
    if (!candidate || candidate === document.body || candidate === document.documentElement) {
      throw new Error("browser_capture_target_missing");
    }
    const target = normalizePickTarget(candidate);
    if (!isPickableTarget(target))
      throw new Error("browser_capture_target_excluded");
    return captureElement(target, { now: (/* @__PURE__ */ new Date()).toISOString() });
  }
  exports.captureAtPoint = captureAtPoint;
  exports.install = install;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({});
