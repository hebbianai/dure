// Run against `mint dev` or the deployed docs:
// node scripts/check-docs-product-figures.mjs http://localhost:3098
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const base = process.argv[2];
assert(base, "Pass the Mintlify preview or production URL");
const output = resolve("output/playwright/docs-product-figures/browser");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30_000);
const errors = [];
const observations = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });

async function inspect(scene, locale) {
  const figure = page.locator(`.dure-figure[data-scene="${scene}"]`);
  await figure.waitFor({ state: "visible" });
  await figure.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }));
  const iframe = figure.locator("iframe");
  await iframe.waitFor({ state: "visible" });
  await figure.locator(".dure-figure-wallpaper").evaluate(image => image.decode());
  const frame = await (await iframe.elementHandle()).contentFrame();
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  await frame.waitForFunction(dark =>
    document.querySelector("#root") &&
    document.documentElement.dataset.figureReady === "true" &&
    document.documentElement.classList.contains("dark") === dark, dark);
  const result = await figure.evaluate(element => {
    const box = element.querySelector(".dure-figure-viewport").getBoundingClientRect();
    const iframe = element.querySelector("iframe");
    const child = iframe.getBoundingClientRect();
    const window = element.querySelector(".dure-figure-window").getBoundingClientRect();
    const [x, y, cropWidth, cropHeight] = element.querySelector(".dure-figure-window").dataset.crop.split(",").map(Number);
    const scale = child.width / 1344;
    return {
      label: element.getAttribute("aria-label"),
      example: element.querySelector(".dure-figure-example").textContent,
      width: box.width,
      layout: element.dataset.layout,
      pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
      contained: box.left >= 0 && box.right <= innerWidth + 1 && getComputedStyle(element.querySelector(".dure-figure-viewport")).overflow === "hidden",
      windowContained: window.left >= box.left && window.right <= box.right + 1 && window.top >= box.top && window.bottom <= box.bottom + 1,
      edgeCrop: window.left >= box.left && window.right <= box.right + 1 && Math.abs(window.bottom - box.bottom) < 1,
      mask: getComputedStyle(element.querySelector(".dure-figure-window")).maskImage,
      cropMatches: Math.abs(child.left + x * scale - window.left) < 1 && Math.abs(child.top + y * scale - window.top) < 1 && Math.abs(window.width - cropWidth * scale) < 1 && Math.abs(window.height - cropHeight * scale) < 1,
      background: element.querySelector(".dure-figure-stage").dataset.background,
      shadow: getComputedStyle(element.querySelector(".dure-figure-window")).boxShadow,
      sandbox: iframe.getAttribute("sandbox"),
      pointerEvents: getComputedStyle(iframe).pointerEvents,
      tabIndex: iframe.tabIndex,
    };
  });
  const app = await frame.evaluate(() => {
    const visible = node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const panes = [...document.querySelectorAll(".dv-groupview")].filter(visible);
    const button = document.querySelector("button");
    button?.focus();
    return {
      width: innerWidth, height: innerHeight,
      inert: document.body.inert,
      tookFocus: Boolean(button && document.activeElement === button),
      scripts: document.scripts.length,
      media: document.querySelectorAll("video,canvas,iframe").length,
      externalImages: [...document.images].filter(image => !image.src.startsWith("data:")).length,
      appRuntime: typeof window.__DURE_STORE__,
      panes: panes.length,
      paneColumns: new Set(panes.map(node => Math.round(node.getBoundingClientRect().left))).size,
      paneRows: new Set(panes.map(node => Math.round(node.getBoundingClientRect().top))).size,
      scrollRestored: [...document.querySelectorAll("[data-figure-scroll]")].every(node => {
        const [left, top] = node.getAttribute("data-figure-scroll").split(",").map(Number);
        return Math.abs(node.scrollLeft - left) < 1 && Math.abs(node.scrollTop - top) < 1;
      }),
      sessions: [...document.querySelectorAll("[data-dure-media-session-id]")].filter(visible).map(node => node.dataset.dureMediaSessionId),
      font: getComputedStyle(document.body).fontFamily,
      dark: document.documentElement.classList.contains("dark"),
    };
  });
  Object.assign(result, { app });
  assert(result.label?.includes(result.example) && !result.label.includes("undefined"), `${scene}/${locale}: localized description`);
  assert(result.width > 200 && result.pageFits && result.contained, `${scene}/${locale}: captured viewport fits ${JSON.stringify(result)}`);
  assert(result.cropMatches, `${scene}: the real UI uses a uniform crop and scale`);
  if (result.layout === "crop") assert(result.edgeCrop, `${scene}: enlarged UI reaches the lower edge without cutting off controls on the right`);
  else assert(result.windowContained, `${scene}: framed and faded UI remain inside the figure`);
  if (result.layout === "spotlight") assert.notEqual(result.mask, "none", `${scene}: focused detail fades into the page`);
  assert.notEqual(result.shadow, "none");
  assert.equal(result.sandbox, "allow-scripts");
  assert.equal(result.pointerEvents, "none");
  assert.equal(result.tabIndex, -1);
  assert(app.inert && !app.tookFocus, "captured controls cannot take focus");
  assert.equal(app.scripts, 1, "only the captured scroll-position restore script is shipped");
  assert.equal(app.appRuntime, "undefined");
  assert.equal(app.media, 0, "the captured UI uses HTML rather than video or canvas");
  assert.equal(app.externalImages, 0, "provider glyph assets are self-contained");
  assert.equal(app.width, 1344);
  assert.equal(app.height, 822);
  assert(app.scrollRestored, `${scene}: captured scroll positions are restored`);
  if (["workspace", "arrangement"].includes(scene)) {
    assert.equal(app.panes, 6);
    assert.equal(app.paneColumns, 3);
    assert.equal(app.paneRows, 2);
  }
  const providerSession = { codex: "session-codex", claude: "session-claude", pi: "session-release-gate" }[scene];
  if (providerSession) assert.deepEqual(app.sessions, [providerSession], "provider tab selects its own actual pane");
  observations.push({ scene, locale, ...result });
  return result;
}

try {
  for (const locale of ["en", "ko", "cn", "jp"]) {
    for (const name of await readdir(`docs/public/${locale}`)) {
      if (!name.endsWith(".mdx")) continue;
      const source = await readFile(`docs/public/${locale}/${name}`, "utf8");
      const scenes = [...source.matchAll(/<ProductFigure scene="([^"]+)"/g)].map(match => match[1]);
      if (!scenes.length) continue;
      const route = `${locale}/${name.replace(/\.mdx$/, "")}`;
      await page.goto(new URL(route, base.endsWith("/") ? base : `${base}/`).href, { waitUntil: "domcontentloaded" });
      for (const scene of scenes) {
        const provider = { codex: "Codex", claude: "Claude Code", pi: "Pi" }[scene];
        if (provider) await page.getByRole("tab", { name: provider, exact: true }).click();
        await inspect(scene, locale);
      }
      console.log(`Verified ${route}`);
      if (locale !== "en") continue;
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const dark of [false, true]) {
          await page.getByRole("button", { name: dark ? "Switch to dark theme" : "Switch to light theme", exact: true }).first().click();
          for (const scene of scenes) {
            const provider = { codex: "Codex", claude: "Claude Code", pi: "Pi" }[scene];
            if (provider) await page.getByRole("tab", { name: provider, exact: true }).click();
            await inspect(scene, locale);
            await page.locator(`.dure-figure[data-scene="${scene}"]`).screenshot({ path: resolve(output, `${scene}-${width}-${dark ? "dark" : "light"}.png`) });
          }
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  }
  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);
  assert.equal(new Set(observations.map(item => item.scene)).size, 14);
  assert.equal(new Set(observations.map(item => item.background)).size, 12);
  assert.deepEqual([...new Set(observations.map(item => item.layout))].sort(), ["crop", "spotlight", "window"]);
  await writeFile(resolve(output, "browser-check.json"), `${JSON.stringify({ base, observations, errors }, null, 2)}\n`);
  console.log(`${observations.length} rendered figure checks passed across four locales, desktop/mobile and light/dark.`);
} finally {
  await browser.close();
}
