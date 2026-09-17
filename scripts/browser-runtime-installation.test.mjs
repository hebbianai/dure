import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, test } from "vitest";
import { installBrowserRuntime } from "./lib/browser-runtime-installation.mjs";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "browser-installation-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const options = {
		home: join(root, "home"),
		engine: join(root, "engine"),
		chromium: join(root, "chromium"),
		chromiumExecutable: "Browser",
		materials: join(root, "materials"),
	};
	await mkdir(options.chromium);
	await mkdir(options.materials);
	await writeFile(options.engine, "#!/bin/sh\necho engine\n", { mode: 0o755 });
	await writeFile(
		join(options.chromium, "Browser"),
		"#!/bin/sh\necho browser\n",
		{ mode: 0o755 },
	);
	await mkdir(join(options.chromium, "Versions"));
	await writeFile(
		join(options.chromium, "Versions", "version"),
		"original resources",
	);
	await symlink("Versions/version", join(options.chromium, "Current"));
	await writeFile(join(options.materials, "NOTICE"), "original notice bytes\n");
	const bytes = await readFile(options.engine);
	const enginePin = {
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
	return {
		root,
		options,
		enginePin,
		install: (dependencies = {}) =>
			installBrowserRuntime(options, { enginePin, ...dependencies }),
		activation: join(options.home, "browser", "installation.json"),
	};
}

async function noTemporaryFiles(home) {
	assert.deepEqual(
		(await readdir(join(home, "browser"))).filter((name) =>
			name.startsWith(".installation-"),
		),
		[],
	);
	assert.deepEqual(
		(await readdir(join(home, "browser", "versions"))).filter((name) =>
			name.startsWith(".install-"),
		),
		[],
	);
}

test("activates complete executable, internal symlink, notices and source manifest together", async () => {
	const f = await fixture();
	const installed = await f.install();
	assert.deepEqual(
		JSON.parse(await readFile(f.activation, "utf8")),
		installed.installation,
	);
	assert.equal((await stat(f.activation)).mode & 0o777, 0o600);
	assert.equal(
		await readFile(installed.installation.engineExecutable, "utf8"),
		await readFile(f.options.engine, "utf8"),
	);
	assert.equal(
		await readlink(
			join(installed.installation.chromiumExecutable, "..", "Current"),
		),
		"Versions/version",
	);
	assert.equal(
		await readFile(join(installed.materials, "NOTICE"), "utf8"),
		"original notice bytes\n",
	);
	const manifest = JSON.parse(await readFile(installed.manifest, "utf8"));
	assert.equal(manifest.engine.sha256, f.enginePin.sha256);
	assert.ok(
		manifest.chromium.some(
			(entry) => entry.path === "Versions/version" && entry.sha256,
		),
	);
	assert.ok(
		manifest.materials.some((entry) => entry.path === "NOTICE" && entry.sha256),
	);
	await noTemporaryFiles(f.options.home);
});

test("an update switches the activation file and preserves the old generation's executable and notices", async () => {
	const f = await fixture();
	const original = await f.install();
	await writeFile(
		join(f.options.chromium, "Versions", "version"),
		"updated resources",
	);
	await writeFile(
		join(f.options.materials, "NOTICE"),
		"updated notice bytes\n",
	);
	const updated = await f.install();
	assert.notEqual(updated.generation, original.generation);
	assert.deepEqual(
		JSON.parse(await readFile(f.activation, "utf8")),
		updated.installation,
	);
	assert.equal(
		await readFile(
			join(original.installation.chromiumExecutable, "..", "Current"),
			"utf8",
		),
		"original resources",
	);
	assert.equal(
		await readFile(join(original.materials, "NOTICE"), "utf8"),
		"original notice bytes\n",
	);
	assert.equal(
		await readFile(
			join(updated.installation.chromiumExecutable, "..", "Current"),
			"utf8",
		),
		"updated resources",
	);
	await noTemporaryFiles(f.options.home);
});

test("simultaneous identical installs converge without modifying a published generation", async () => {
	const f = await fixture();
	const [first, second] = await Promise.all([f.install(), f.install()]);
	assert.deepEqual(first, second);
	assert.deepEqual(await readdir(join(f.options.home, "browser", "versions")), [
		first.generation,
	]);
	assert.deepEqual(
		JSON.parse(await readFile(f.activation, "utf8")),
		first.installation,
	);
	await noTemporaryFiles(f.options.home);
});

test.each([
	"engine-corrupt",
	"source-copy-changed",
	"copy-failed",
	"external-link",
	"empty-materials",
])("failed update retains previous activation and bytes: %s", async (fault) => {
	const f = await fixture();
	const first = await f.install();
	const before = await readFile(f.activation, "utf8");
	let copyDirectory = cp;
	if (fault === "engine-corrupt") await writeFile(f.options.engine, "corrupt");
	else if (fault === "empty-materials")
		await rm(join(f.options.materials, "NOTICE"));
	else if (fault === "external-link")
		await symlink("../engine", join(f.options.materials, "outside"));
	else
		copyDirectory = async (source, destination, options) => {
			await cp(source, destination, options);
			if (fault === "copy-failed") throw new Error("fixture copy interrupted");
			if (source === (await realpath(f.options.chromium)))
				await writeFile(
					join(destination, "Versions", "version"),
					"changed during copy",
				);
		};
	await assert.rejects(
		f.install({ copyDirectory }),
		/browser_engine_pin_mismatch|browser_installation_source_changed|fixture copy interrupted|browser_installation_external_link|browser_installation_materials_empty/,
	);
	assert.equal(await readFile(f.activation, "utf8"), before);
	assert.equal(
		await readFile(
			join(first.installation.chromiumExecutable, "..", "Current"),
			"utf8",
		),
		"original resources",
	);
	assert.equal(
		await readFile(join(first.materials, "NOTICE"), "utf8"),
		"original notice bytes\n",
	);
	await noTemporaryFiles(f.options.home);
});

test("refuses to repair tampered published bytes in place", async () => {
	const f = await fixture();
	const first = await f.install();
	const before = await readFile(f.activation, "utf8");
	await writeFile(
		first.installation.chromiumExecutable,
		"changed published browser",
	);
	await assert.rejects(f.install(), /browser_installation_generation_changed/);
	assert.equal(await readFile(f.activation, "utf8"), before);
	assert.equal(
		await readFile(first.installation.chromiumExecutable, "utf8"),
		"changed published browser",
	);
	await noTemporaryFiles(f.options.home);
});

test("rejects an executable outside its package and a non-executable input", async () => {
	const f = await fixture();
	await assert.rejects(
		installBrowserRuntime(
			{ ...f.options, chromiumExecutable: "../engine" },
			{ enginePin: f.enginePin },
		),
		/browser_installation_executable_invalid/,
	);
	await chmod(f.options.engine, 0o600);
	await assert.rejects(f.install(), /browser_installation_executable_invalid/);
	await assert.rejects(stat(f.activation), { code: "ENOENT" });
});
