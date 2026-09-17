#!/usr/bin/env node
import { resolve } from "node:path";
import { installBrowserRuntime } from "./lib/browser-runtime-installation.mjs";

const options = {};
const names = new Map([
	["--home", "home"],
	["--engine", "engine"],
	["--chromium", "chromium"],
	["--chromium-executable", "chromiumExecutable"],
	["--materials", "materials"],
]);
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
	const name = names.get(args[index]);
	if (
		!name ||
		!args[index + 1] ||
		args[index + 1].startsWith("--") ||
		options[name] !== undefined
	) {
		throw new Error(
			"usage: install-browser-runtime.mjs --home PATH --engine PATH --chromium DIRECTORY --chromium-executable RELATIVE_PATH --materials DIRECTORY",
		);
	}
	options[name] =
		name === "chromiumExecutable" ? args[index + 1] : resolve(args[index + 1]);
}
console.log(JSON.stringify(await installBrowserRuntime(options), null, 2));
