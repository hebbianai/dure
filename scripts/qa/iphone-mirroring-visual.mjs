import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
const output = resolve("output/playwright/iphone-mirroring");
mkdirSync(output, { recursive: true });
const server = await createServer({
	configFile: resolve("vite.config.ts"),
	cacheDir: resolve("node_modules/.vite-iphone-mirroring"),
	optimizeDeps: { entries: ["scripts/qa/iphone-mirroring.fixture.html"] },
	logLevel: "warn",
	server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
});
let browser;
try {
	await server.listen();
	const address = server.httpServer.address();
	browser = await chromium.launch();
	const page = await browser.newPage({
		viewport: { width: 440, height: 900 },
		colorScheme: "dark",
		reducedMotion: "reduce",
	});
	const errors = [];
	page.on("pageerror", (error) => errors.push(String(error)));
	await page.goto(
		`http://127.0.0.1:${address.port}/scripts/qa/iphone-mirroring.fixture.html`,
		{ waitUntil: "networkidle" },
	);
	await page
		.getByRole("img", { name: "iPhone (iPhone Mirroring) screen" })
		.waitFor();
	for (const width of [440, 320]) {
		await page.setViewportSize({ width, height: 900 });
		await page.getByRole("checkbox", { name: "Auto refresh (1s)" }).check();
		assert.equal(
			await page
				.getByRole("checkbox", { name: "Live iOS (experimental)" })
				.count(),
			0,
		);
		assert.equal(await page.getByRole("button", { name: "Start" }).count(), 0);
		await page.getByRole("button", { name: "Home", exact: true }).click();
		await page
			.getByRole("img", { name: "iPhone (iPhone Mirroring) screen" })
			.waitFor();
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
			false,
		);
		await page.screenshot({ path: resolve(output, `${width}px.png`) });
	}
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			source: "browser-fixture",
			widths: [440, 320],
			output,
			nativeEvidence: false,
		}),
	);
} finally {
	await browser?.close();
	await server.close();
}
