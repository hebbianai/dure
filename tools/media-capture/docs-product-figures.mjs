// Export static DOM from the shipped app. No product UI is drawn in this file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { scenarioById } from "./scenarios.mjs";
import { startCaptureServer, preparePage, runAction } from "./runtime/browser-capture.mjs";
import { readApplicationBuild } from "./runtime/application-build.mjs";

const output = resolve("output/playwright/docs-product-figures");
const scenes = ["workspace", "new-agent", "github", "arrangement", "desktops", "settings", "onboarding", "diff-review", "review-comment", "ssh", "terminal", "codex", "claude", "pi"];
const bundleOnly = process.argv.includes("--bundle");
const requested = process.argv.slice(2).filter(arg => arg !== "--bundle");
assert(requested.every(scene => scenes.includes(scene)), "Pass scene names, or no arguments for all scenes");
const viewport = { width: 1344, height: 822, deviceScaleFactor: 1 };
const freezeCss = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html,body{overscroll-behavior:auto!important}";
// A document can load while its docs container is hidden. Restore only after
// the scroll viewport has a visible layout and its fonts have loaded.
const restoreScroll = "addEventListener('load',async()=>{const scrollers=[...document.querySelectorAll('[data-figure-scroll]')];const surfaces=scrollers.length?scrollers:[document.body];await new Promise(resolve=>{const observer=new ResizeObserver(()=>{if(surfaces.every(el=>el.clientWidth&&el.clientHeight)){observer.disconnect();resolve()}});surfaces.forEach(el=>observer.observe(el))});await document.fonts.ready;scrollers.forEach(el=>{const [left,top]=el.getAttribute('data-figure-scroll').split(',').map(Number);el.scrollLeft=left;el.scrollTop=top});document.documentElement.dataset.figureReady='true'},{once:true})";
const restoreHash = createHash("sha256").update(restoreScroll).digest("base64");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

function fixtureFor(scene) {
  const source = scene === "onboarding" ? "onboarding-walkthrough" : ["new-agent", "github"].includes(scene) ? `tour-${scene === "github" ? "github-issue" : scene}` : "workspace-overview";
  const scenario = JSON.parse(JSON.stringify(scenarioById(source)).replaceAll("/workspace/dure", "/workspace/launchpad"));
  scenario.captureStage = { schemaVersion: 1, mode: "full-frame" };
  scenario.viewport = viewport;
  scenario.interfaceMode = scene === "settings" ? "basic" : "pro";
  scenario.terminalFontSize = 12;
  if (["workspace", "arrangement"].includes(scene)) {
    scenario.liveTerminalSize = { columns: 40, rows: 18 };
    scenario.liveProviderTerminalSizes = {};
    scenario.liveSessionTerminalSizes = {};
  }
  if (source !== "workspace-overview") return scenario;
  scenario.setup = [];
  scenario.fixture.projects[0].name = "launchpad";
  scenario.fixture.desktops[0].name = "Main";
  scenario.fixture.desktops[2].name = "Build";
  const pi = scenario.fixture.agents.find(agent => agent.id === "agent-release-gate");
  pi.provider = "pi";
  pi.name = "release-notes";
  scenario.fixture.installedAgents.push("pi");
  scenario.fixture.terminalSnapshots[pi.sessionId] = "\u001b[1mPi\u001b[0m\r\n\r\nSummarize the changes for this release.\r\n\r\nRead CHANGELOG.md\r\n\u001b[32mRelease notes are ready for review.\u001b[0m\r\n\r\n❯ ";
  scenario.fixture.terminalScreensByCwd["/workspace/launchpad"] = "$ npm test\r\n\r\n\u001b[32m✓ search matches mixed case\r\n✓ empty query keeps all tasks\r\n✓ labels remain readable\u001b[0m\r\n\r\n3 tests passed\r\n\r\n$ git status --short\r\n\r\n$ ";
  const review = scenario.fixture.diffReviews["agent-session-recovery"];
  review.diff = ["diff --git a/src/search.mjs b/src/search.mjs", "--- a/src/search.mjs", "+++ b/src/search.mjs", "@@ -1,4 +1,6 @@", " export function search(tasks, query) {", "+  const value = query.toLowerCase();", "   return tasks.filter(task =>", "-    task.title.includes(query));", "+    task.title.toLowerCase()", "+      .includes(value));", " }", "diff --git a/tests/search.test.mjs b/tests/search.test.mjs", "new file mode 100644", "--- /dev/null", "+++ b/tests/search.test.mjs", "@@ -0,0 +1,4 @@", "+test('matches mixed case', () => {", "+  const tasks = [{ title: 'Build search' }];", "+  assert.deepEqual(search(tasks, 'SEARCH'), tasks);", "+});", ""].join("\n");
  const reviewPaths = [...review.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
  assert.equal(reviewPaths.length, 2);
  review.files = [{ path: reviewPaths[0], oldPath: null, added: 3, deleted: 1, status: "M" }, { path: reviewPaths[1], oldPath: null, added: 4, deleted: 0, status: "A" }];
  scenario.fixture.diffBadges["agent-session-recovery"] = { added: 7, deleted: 1, binary: 0, files: 2 };
  return scenario;
}

async function arrange(page, scene) {
  await page.evaluate(scene => {
    const dock = window.__DURE_DOCK__;
    const state = window.__DURE_STORE__.getState();
    const api = dock.getDockview(state.activeDesktopId);
    const original = [...api.panels];
    const open = (id, position) => dock.openAgentPanel(state.activeDesktopId, state.agents.find(agent => agent.id === id), position);
    const single = { codex: "agent-session-recovery", claude: "agent-docs-polish", pi: "agent-release-gate" }[scene];
    if (single) {
      open(single);
      original.forEach(panel => panel.api.close());
    } else if (["workspace", "arrangement"].includes(scene)) {
      const left = open("agent-session-recovery");
      original.forEach(panel => panel.api.close());
      const middle = open("agent-docs-polish", { referencePanel: left, direction: "right" });
      const right = open("agent-release-gate", { referencePanel: middle, direction: "right" });
      open("agent-keyboard-nav", { referencePanel: left, direction: "below" });
      open("agent-copy-review", { referencePanel: middle, direction: "below" });
      const sessionId = dock.openLocalTerminalOn(api, "/workspace/launchpad", { referencePanel: right, direction: "below" });
      window.__DURE_MEDIA_CAPTURE_MOCK__.registerTerminalCwd(sessionId, "/workspace/launchpad");
    } else {
      const left = open("agent-session-recovery");
      if (scene === "ssh") open("agent-api-review", { referencePanel: left, direction: "right" });
      if (scene === "desktops") open("agent-copy-review", { referencePanel: left, direction: "below" });
      if (scene !== "terminal" && scene !== "desktops") original.forEach(panel => panel.api.close());
    }
  }, scene);
}

async function prepareScene(page, scene, scenario) {
  if (scene === "new-agent") {
    await runAction(page, { action: "productTour", gesture: "open-new" }, scenario);
    await page.getByRole("textbox", { name: "New agent", exact: true }).fill("Find how this project runs its tests and run the relevant command. Do not change files.");
    await page.getByRole("switch", { name: /Isolate/ }).check();
  } else if (scene === "github") {
    await runAction(page, { action: "productTour", gesture: "github" }, scenario);
    await runAction(page, { action: "productTour", gesture: "issue-start" }, scenario);
  } else if (scene === "onboarding") {
    for (const action of scenario.timeline.slice(0, 3)) await runAction(page, action, scenario);
    await page.locator("[data-import-desktop-id]").first().evaluate(element => element.scrollIntoView({ block: "center" }));
  } else {
    if (scene === "desktops") await runAction(page, { action: "activateDesktop", desktopId: "desk-review" }, scenario);
    await arrange(page, scene);
    if (scene === "settings") {
      await page.keyboard.press("Meta+,");
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      await page.locator('button[aria-expanded="true"]').filter({ hasText: "Color scheme" }).click();
      await page.getByRole("spinbutton", { name: "Line height", exact: true }).fill("1.35");
      await page.getByRole("spinbutton", { name: "Line height", exact: true }).press("Enter");
      await page.getByRole("spinbutton", { name: "Line height", exact: true }).blur();
    }
    if (["diff-review", "review-comment"].includes(scene)) {
      await page.addScriptTag({ type: "module", content: `
        import { openDiffPanel } from "/src/lib/workspace/dock/openScmPanel.ts";
        const api = window.__DURE_DOCK__.getDockview("desk-launch");
        const original = [...api.panels];
        openDiffPanel("desk-launch", "agent-session-recovery", "Search tests");
        for (const panel of original) panel.api.close();
      ` });
      await page.getByRole("button", { name: "All files (2)", exact: true }).waitFor();
      await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
      await page.getByRole("button", { name: /src\/search.mjs/ }).click();
      if (scene === "diff-review") await page.getByRole("button", { name: "Side-by-side view", exact: true }).click();
      else {
        await page.getByPlaceholder("Comment on search.mjs… (⌘Enter to add)").fill("Test mixed case; preserve empty queries.");
        await page.getByPlaceholder("Comment on search.mjs… (⌘Enter to add)").blur();
      }
    }
    if (["workspace", "arrangement"].includes(scene)) {
      await page.keyboard.press("Meta+Shift+b");
    }
    if (scene === "arrangement") {
      // Native drag images live outside the page and disappear from DOM exports.
      // Retain the exact Dockview ghost, including its native pointer offset.
      await page.evaluate(() => {
        const setDragImage = DataTransfer.prototype.setDragImage;
        let ghost;
        let offset;
        DataTransfer.prototype.setDragImage = function (element, x, y) {
          setDragImage.call(this, element, x, y);
          const bounds = element.getBoundingClientRect();
          ghost = element.cloneNode(true);
          ghost.setAttribute("data-figure-drag-image", "");
          ghost.setAttribute("aria-hidden", "true");
          // Dockview copies logical insets from its source tab. They would
          // override the physical cursor coordinates on a retained DOM node.
          ghost.style.removeProperty("inset-block");
          ghost.style.removeProperty("inset-inline");
          Object.assign(ghost.style, { position: "fixed", right: "auto", bottom: "auto", pointerEvents: "none", zIndex: "9999" });
          // Preserve the native snapshot's dimensions after moving out of its
          // stretched offscreen containing block.
          ghost.style.setProperty("width", `${bounds.width}px`, "important");
          ghost.style.setProperty("height", `${bounds.height}px`, "important");
          offset = { x, y };
          document.body.appendChild(ghost);
          DataTransfer.prototype.setDragImage = setDragImage;
        };
        const moveGhost = event => {
          if (!ghost) return;
          ghost.style.left = `${event.clientX - offset.x}px`;
          ghost.style.top = `${event.clientY - offset.y}px`;
        };
        document.addEventListener("dragover", moveGhost, true);
        document.addEventListener("dragend", () => {
          document.removeEventListener("dragover", moveGhost, true);
          DataTransfer.prototype.setDragImage = setDragImage;
          ghost?.remove();
        }, { once: true });
      });
      const from = await page.locator('[data-pane-title]').filter({ hasText: "release-gate" }).first().boundingBox();
      const target = await page.locator('.dv-groupview').filter({ has: page.locator('[data-pane-title]').filter({ hasText: "session-recovery" }) }).boundingBox();
      await page.mouse.move(from.x + 60, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 72, from.y + from.height / 2 + 12, { steps: 3 });
      await page.mouse.move(target.x + target.width - 24, target.y + target.height / 2, { steps: 30 });
      await page.locator('.pane-drop-recommendation-label').filter({ hasText: "Split Right" }).waitFor();
      await page.locator('[data-figure-drag-image]').filter({ hasText: "release-gate" }).waitFor();
      const ghost = await page.locator('[data-figure-drag-image]').boundingBox();
      assert(ghost.x >= target.x && ghost.x < target.x + target.width && ghost.y >= target.y && ghost.y < target.y + target.height, "Retained drag image must follow the pointer over the target pane");
    }
  }
}

async function exportDocument(page, baseUrl) {
  const data = await page.evaluate(() => {
    const body = document.body.cloneNode(true);
    const elements = document.body.querySelectorAll("*");
    body.querySelectorAll("*").forEach((node, index) => {
      const original = elements[index];
      if (original.scrollLeft || original.scrollTop) node.setAttribute("data-figure-scroll", `${original.scrollLeft},${original.scrollTop}`);
      for (const state of ["hover", "focus", "focus-visible", "focus-within", "active"]) {
        if (original.matches(`:${state}`)) node.setAttribute(`data-figure-${state}`, "");
      }
    });
    const originals = document.querySelectorAll("input,textarea");
    body.querySelectorAll("input,textarea").forEach((node, index) => {
      if (node.tagName === "TEXTAREA") node.textContent = originals[index].value;
      else node.setAttribute("value", originals[index].value);
    });
    body.querySelectorAll("script,link,style,vite-error-overlay").forEach(node => node.remove());
    body.querySelectorAll("*").forEach(node => {
      for (const attribute of [...node.attributes]) {
        if (attribute.name.startsWith("on") || attribute.name === "data-dure-src" || attribute.name === "srcset") node.removeAttribute(attribute.name);
      }
      if (node.tagName === "A") node.removeAttribute("href");
    });
    return {
      body: body.innerHTML,
      bodyClass: document.body.className,
      bodyStyle: document.body.getAttribute("style") || "",
      htmlClass: document.documentElement.className,
      htmlStyle: document.documentElement.getAttribute("style") || "",
      css: [...document.styleSheets].map(sheet => [...sheet.cssRules].map(rule => rule.cssText).join("\n")).join("\n"),
      images: [...body.querySelectorAll("img[src]")].map(node => node.getAttribute("src")),
    };
  });
  const urls = [...new Set([...data.css.matchAll(/url\(["']?([^\)"']+)["']?\)/g)].map(match => match[1]).concat(data.images))];
  for (const path of urls) {
    if (path.startsWith("data:") || path.startsWith("#")) continue;
    const response = await fetch(new URL(path, baseUrl));
    assert(response.ok, path);
    const encoded = `data:${response.headers.get("content-type").split(";")[0]};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    data.css = data.css.replaceAll(path, encoded);
    data.body = data.body.replaceAll(`src="${path}"`, `src="${encoded}"`);
  }
  // Freeze source hover/focus paint while keeping the exported controls inert.
  data.css = data.css.replace(/(?<!\\):(hover|focus-visible|focus-within|focus|active)\b/g, "[data-figure-$1]");
  delete data.images;
  assert(!/\/Users\/|\/home\/|localhost|127\.0\.0\.1|data-dure-src|<script/i.test(data.body + data.css), "Captured figures must not leak private/dev data or executable content");
  return data;
}

function documentHtml(data) {
  return `<!doctype html><html class="${data.htmlClass}" style="${data.htmlStyle}" lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'sha256-${restoreHash}'"><style>${data.css}</style></head><body inert class="${data.bodyClass}" style="${data.bodyStyle}">${data.body}<script>${restoreScroll}</script></body></html>`;
}

await mkdir(output, { recursive: true });
const { server, url } = bundleOnly ? {} : await startCaptureServer();
let browser;
const failures = [];
try {
  const build = bundleOnly ? null : await readApplicationBuild(url);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  for (const scene of bundleOnly ? [] : requested.length ? requested : scenes) {
    const scenario = fixtureFor(scene);
    // Start each theme independently: drag ghosts snapshot computed theme styles
    // at dragstart, so changing theme during an existing drag cannot recolor it.
    for (const theme of ["dark", "light"]) {
      const { page, context, pageErrors } = await preparePage(browser, url, scenario, build);
      try {
        await page.evaluate(theme => window.__DURE_STORE__.getState().setUiPrefs({ theme }), theme);
        await page.waitForFunction(theme => document.documentElement.classList.contains("dark") === (theme === "dark"), theme);
        await prepareScene(page, scene, scenario);
        await page.addStyleTag({ content: freezeCss });
        if (scene !== "arrangement") await page.mouse.move(1343,821);
        if (scene === "settings") {
          const expanded = page.locator('button[aria-expanded="true"]').filter({ hasText: /color scheme/i });
          if (await expanded.count()) await expanded.first().click();
          await page.getByRole("spinbutton", { name: "Line height", exact: true }).scrollIntoViewIfNeeded();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
        const data = await exportDocument(page, url);
        const html = documentHtml(data);
        await writeFile(resolve(output, `${scene}-${theme}.json`), JSON.stringify(data));
        await writeFile(resolve(output, `${scene}-${theme}.html`), html);
        await page.screenshot({ path: resolve(output, `${scene}-${theme}-source.png`) });
        const exported = await context.newPage();
        await exported.setContent(html);
        await exported.waitForFunction(() => document.documentElement.dataset.figureReady === "true");
        await exported.screenshot({ path: resolve(output, `${scene}-${theme}-export.png`) });
        await exported.close();
        console.log(`Captured ${scene}/${theme}: ${html.length} HTML bytes`);
        assert.equal(pageErrors.length, 0, pageErrors.map(e => e.message).join("; "));
        assert(!/Agent tooling needs to be|A rendering error occurred|Git availability could not be confirmed/.test(await page.locator("body").innerText()), "Unexpected app error/maintenance state");
      } catch (error) {
        await page.screenshot({ path: resolve(output, `${scene}-${theme}-error.png`) });
        await writeFile(resolve(output, `${scene}-${theme}-error.txt`), await page.locator("body").innerText());
        failures.push(`${scene}/${theme}: ${error.message}`);
        console.error(`${scene}/${theme}: ${error.message}`);
      } finally { await context.close(); }
    }
    if (!failures.some(failure => failure.startsWith(`${scene}/`))) {
      const artifacts = {};
      for (const theme of ["dark", "light"]) for (const suffix of [".json", ".html", "-source.png", "-export.png"]) {
        const name = `${scene}-${theme}${suffix}`;
        artifacts[name] = digest(await readFile(resolve(output, name)));
      }
      await writeFile(resolve(output, `${scene}-receipt.json`), JSON.stringify({ build, scene, viewport, artifacts, errors: [], capturedAt: new Date().toISOString() }, null, 2));
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
  const captured = {};
  const receipts = {};
  for (const scene of scenes) {
    const receipt = JSON.parse(await readFile(resolve(output, `${scene}-receipt.json`), "utf8"));
    assert.equal(receipt.scene, scene);
    assert.deepEqual(receipt.viewport, viewport);
    assert.deepEqual(receipt.errors, []);
    for (const theme of ["light", "dark"]) for (const suffix of [".json", ".html", "-source.png", "-export.png"]) {
      const name = `${scene}-${theme}${suffix}`;
      assert.equal(digest(await readFile(resolve(output, name))), receipt.artifacts[name], `${name}: recapture changed or incomplete evidence`);
    }
    receipts[scene] = receipt;
    captured[scene] = {};
    for (const theme of ["light", "dark"]) {
      captured[scene][theme] = JSON.parse(await readFile(resolve(output, `${scene}-${theme}.json`), "utf8"));
    }
  }
  const cssPage = await browser.newPage();
  const css = await cssPage.evaluate(sheets => {
    const rules = new Set();
    for (const css of sheets) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      for (const rule of sheet.cssRules) rules.add(rule.cssText);
    }
    return [...rules].join("\n");
  }, Object.values(captured).flatMap(variants => Object.values(variants).map(data => data.css)));
  await cssPage.close();
  for (const variants of Object.values(captured)) for (const data of Object.values(variants)) delete data.css;
  const compressed = value => gzipSync(value, { level: 9 }).toString("base64");
  const payloads = Object.fromEntries(Object.entries(captured).map(([scene, variants]) => [scene,
    Object.fromEntries(Object.entries(variants).map(([theme, data]) => [theme, compressed(JSON.stringify(data))])),
  ]));
  const template = await readFile("tools/media-capture/docs-product-figure.jsx", "utf8");
  const component = "// Generated by tools/media-capture/docs-product-figures.mjs; edit its template instead.\n" + template.replace("__CAPTURE_PAYLOADS__", JSON.stringify(payloads)).replace("__CAPTURE_STYLES__", compressed(css)).replace('"__CAPTURE_RESTORE__"', JSON.stringify(restoreScroll)).replace("__CAPTURE_RESTORE_HASH__", restoreHash);
  await writeFile(resolve(output, "product-figure.jsx"), component);
  await writeFile(resolve(output, "bundle-receipt.json"), JSON.stringify({ captures: receipts, cssBytes: css.length, componentSha256: digest(component), generatedAt: new Date().toISOString() }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
