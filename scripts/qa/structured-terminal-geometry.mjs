#!/usr/bin/env node

// Browser-only geometry regression: real component/CSS, synthetic Host records.
// No desktop, credentials, provider processes, or Live app are accessed.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = process.argv.includes("--phone-width") ? "phone-width.jsx" : "fixture.jsx";
const route = "/__qa/structured-terminal-geometry";
const server = await createServer({
  root,
  configFile: false,
  cacheDir: "node_modules/.vite-terminal-geometry",
  resolve: { alias: { "@": resolve(root, "src") } },
  plugins: [react(), tailwindcss(), {
    name: "structured-terminal-geometry-fixture",
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?", 1)[0] !== route) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await vite.transformIndexHtml(route, `<!doctype html>
          <html class="dark"><meta charset="utf-8"><title>Terminal geometry QA</title>
          <body><div id="root" style="width:267.5px;height:240px"></div>
          <script src="/scripts/qa/tauri-mock.js"></script>
          <script type="module" src="/scripts/qa/structured-terminal-geometry/${fixture}"></script>
          </body></html>`));
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const address = server.httpServer.address();
console.log(`Open http://127.0.0.1:${address.port}${route}; read window.__terminalGeometryResult.`);
process.once("SIGINT", async () => { await server.close(); process.exit(0); });
process.once("SIGTERM", async () => { await server.close(); process.exit(0); });

if (process.argv.includes("--check")) {
  const { chromium, webkit } = await import("@playwright/test");
  const reports = [];
  try {
    for (const [name, engine] of Object.entries({ chromium, webkit })) {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 500, height: 440 } });
        const browserErrors = [];
        page.on("pageerror", (error) => browserErrors.push(String(error)));
        await page.goto(`http://127.0.0.1:${address.port}${route}`);
        await page.waitForFunction(() => window.__phoneWidthReady || window.__terminalGeometryResult);
        if (await page.evaluate(() => Boolean(window.__phoneWidthReady))) {
          const layer = page.locator('[data-testid="structured-terminal-presentation"]');
          await layer.evaluate((element) => { element.scrollLeft = 0; });
          await page.mouse.move(120, 100);
          await page.mouse.wheel(80, 0);
          await page.waitForFunction(() => {
            const layer = document.querySelector('[data-testid="structured-terminal-presentation"]');
            return Math.abs(layer.scrollLeft - 80) <= 1;
          });
          await page.evaluate(() => window.__finishPhoneWidth());
        }
        const result = await page.evaluate(() => window.__terminalGeometryResult);
        reports.push({ engine: name, ...result, browserErrors });
      } finally { await browser.close(); }
    }
    console.log(JSON.stringify(reports));
    if (reports.some((report) => report.errors.length || report.browserErrors.length)) process.exitCode = 1;
  } finally { await server.close(); }
}
