import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot } from "../paths.mjs";
import { installProductTourEffects, setProductTourCaption } from "./product-tour-effects.mjs";

const pause = (page, ms = 400) => page.waitForTimeout(ms);
const title = (page, name) => page.locator("#desktop-panel-desk-main .dv-groupview").filter({ has: page.locator(`[data-dure-media-session-id="tour-session-${{ "Session handoff": "claude", "Test run": "codex", "Code review": "pi" }[name]}"]`) }).locator("[data-pane-title]");
async function click(page, locator, options) {
  await locator.waitFor({ state: "visible", timeout: 5000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await pause(page, 200);
  await locator.click(options);
}
async function disableWorktree(page) {
  const toggle = page.getByRole("switch", { name: /Isolate/ });
  if (await toggle.isChecked()) await click(page, toggle);
}

export async function runProductTourAction(page, action, scenario) {
  if (action.action !== "productTour") return false;
  page.setDefaultTimeout(6000);
  try {
    if (action.gesture !== "prepare") await setProductTourCaption(page, scenario.fixture.productTour.guide.steps[action.gesture]);
    switch (action.gesture) {
      case "prepare": {
        await page.evaluate(() => window.__DURE_STORE__.getState().setUiPrefs({ defaultProvider: "codex" }));
        await page.addScriptTag({ type: "module", content: `
          import { createAgentRunBackendFixture } from "/src/test/dureAgentRunFixtures.ts";
          let run;
          window.__DURE_PRODUCT_TOUR_RUN__ = async (args) => {
            if (args.operation === "agent_spawn.preview") {
              run = createAgentRunBackendFixture({ projectId: "project-launchpad", providerId: args.body.providerId, backendGeneration: "media-generation", mutateApplyResult(result) {
                const receipt = result.receipt;
                if (receipt.plan.request.promptDigest) receipt.completed.push({ stage: "prompt_delivery", attempt: 1, inputs: { stage: "prompt_delivery" }, evidence: { stage: "prompt_delivery", session_id: "session-run-1", delivery_id: "tour-prompt-1" } });
                return result;
              } });
            }
            if (!run) throw new Error("Product tour requires preview before apply");
            return run.invokeCommand("dure_backend_request", args);
          };
        ` });
        await page.waitForFunction(() => Boolean(window.__DURE_PRODUCT_TOUR_RUN__));
        for (const desktopId of scenario.fixture.desktops.map(({ id }) => id).reverse()) {
          await page.evaluate((id) => window.__DURE_STORE__.getState().setActiveSpace(id), desktopId);
          await page.waitForFunction((id) => Boolean(window.__DURE_DOCK__.getDockview(id)), desktopId);
          await page.evaluate(({ desktopId, main, tourId }) => {
            const dock = window.__DURE_DOCK__;
            const api = dock.getDockview(desktopId);
            const agents = window.__DURE_STORE__.getState().agents;
            const original = [...api.panels];
            const open = (id, position) => dock.openAgentPanel(desktopId, agents.find((agent) => agent.id === id), position);
            if (main) {
              if (["tour-new-agent", "tour-github-issue"].includes(tourId)) open("tour-codex");
              else {
                const left = open("tour-claude");
                if (!["tour-split-codex", "tour-appearance"].includes(tourId)) {
                  const right = open("tour-codex", { referencePanel: left, direction: "right" });
                  open("tour-pi", { referencePanel: right, direction: "below" });
                }
              }
            } else if (desktopId === "desk-build") {
              const left = open("tour-tests");
              const right = open("tour-build-code", { referencePanel: left, direction: "right" });
              open("tour-build-test", { referencePanel: left, direction: "below" });
              open("tour-build-review", { referencePanel: right, direction: "below" });
            } else {
              const top = open(tourId === "tour-space-shortcuts" ? "tour-review" : "tour-codex");
              if (tourId === "tour-space-shortcuts") open("tour-review-code", { referencePanel: top, direction: "below" });
            }
            for (const panel of original) panel.api.close();
          }, { desktopId, main: desktopId === "desk-main", tourId: scenario.id });
        }
        await pause(page, 4000);
        await installProductTourEffects(page, scenario.fixture.productTour.guide);
        break;
      }
      case "open-new":
        await page.keyboard.press("Meta+n");
        await page.getByRole("textbox", { name: "New agent", exact: true }).waitFor();
        break;
      case "type-prompt":
        await page.getByRole("textbox", { name: "New agent", exact: true }).pressSequentially("Inspect the session handoff and run npm test. Reply in English.", { delay: 25 });
        await disableWorktree(page);
        break;
      case "start-agent": {
        await disableWorktree(page);
        const before = await page.evaluate(() => window.__DURE_STORE__.getState().agents.map(({ id }) => id));
        await click(page, page.getByRole("button", { name: "Start agent", exact: true }));
        await page.waitForFunction((ids) => window.__DURE_STORE__.getState().agents.some((agent) => !ids.includes(agent.id) && agent.started), before, { timeout: 6000 });
        break;
      }
      case "split":
        await click(page, title(page, "Session handoff"), { button: "right" });
        await click(page, page.getByRole("menuitem", { name: "Split Right", exact: true }));
        await click(page, page.getByRole("menuitem", { name: "New pane", exact: true }));
        break;
      case "add-codex":
        await click(page, page.locator("[data-launcher-row]").filter({ hasText: /^codex/ }));
        await page.waitForFunction(() => window.__DURE_DOCK__.getDockview("desk-main").panels.length === 2);
        break;
      case "github":
        await page.keyboard.press("Meta+2");
        await click(page, page.getByRole("button", { name: "GitHub", exact: true }));
        await page.getByRole("button", { name: "Review stale session handoff", exact: true }).waitFor();
        break;
      case "issue-start":
        await click(page, page.locator("li").filter({ has: page.getByRole("button", { name: "Review stale session handoff", exact: true }) }).getByRole("button", { name: "Start", exact: true }));
        await page.getByRole("textbox", { name: "New agent", exact: true }).waitFor();
        await disableWorktree(page);
        break;
      case "settings":
        await page.keyboard.press("Meta+,");
        await click(page, page.getByRole("tab", { name: "Appearance", exact: true }));
        break;
      case "theme":
        await click(page, page.getByRole("radio", { name: "Light", exact: true }));
        await page.waitForFunction(() => window.__DURE_STORE__.getState().uiPrefs.theme === "light");
        break;
      case "close-settings":
        await page.keyboard.press("Escape");
        break;
      case "space-review":
      case "space-main":
      case "space-build": {
        const desktopId = `desk-${action.gesture.slice(6)}`;
        await click(page, page.locator(`#desktop-tab-${desktopId}`));
        await page.waitForFunction((id) => window.__DURE_STORE__.getState().activeDesktopId === id, desktopId);
        break;
      }
      case "drag-right":
      case "drag-below": {
        const from = await title(page, "Code review").boundingBox();
        const target = await title(page, "Test run").boundingBox();
        const source = { x: from.x + 60, y: from.y + from.height / 2 };
        const right = action.gesture === "drag-right";
        const targetBounds = await title(page, "Test run").evaluate((element) => {
          const rect = element.closest(".dv-groupview").getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        const dest = right
          ? { x: targetBounds.x + targetBounds.width - 30, y: target.y + 100 }
          : { x: targetBounds.x + targetBounds.width / 2, y: targetBounds.y + targetBounds.height - 30 };
        await page.mouse.move(source.x, source.y);
        await pause(page, 180);
        await page.mouse.down();
        await page.mouse.move(source.x + 12, source.y + 12, { steps: 2 });
        for (let step = 1; step <= 30; step++) {
          const t = step / 30;
          const eased = t * t * (3 - 2 * t);
          await page.mouse.move(source.x + (dest.x - source.x) * eased, source.y + (dest.y - source.y) * eased);
          await pause(page, 40);
        }
        await pause(page, 650);
        await page.mouse.up();
        await pause(page);
        break;
      }
      case "outcome": break;
      default: throw new Error(`Unknown product tour gesture: ${action.gesture}`);
    }
    const text = await page.locator("body").innerText();
    if (/[\uac00-\ud7af\u3040-\u30ff\u3400-\u9fff]/u.test(text)) throw new Error("Non-English text is visible in product tour");
    if (/Agent CLI update available|Agent tooling needs to be updated|A rendering error occurred|Dispatch failed/.test(text)) throw new Error("Unexpected maintenance or failure notice in product tour");
    process.stderr.write(`[product-tour] ${scenario.id}: ${action.gesture} verified\n`);
  } catch (error) {
    await mkdir(resolve(repoRoot, "output/playwright"), { recursive: true });
    await page.screenshot({ path: resolve(repoRoot, `output/playwright/${scenario.id}-error.png`) });
    process.stderr.write(JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, intents: localStorage.getItem("dure:quick-dispatch-intents:v1") }))) + "\n");
    throw error;
  }
  return true;
}
