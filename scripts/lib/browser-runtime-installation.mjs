import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	copyFile,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	readlink,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const metadata = JSON.parse(
	await readFile(
		new URL(
			"../../crates/dure-app/control-plane/resources/browser-engine.json",
			import.meta.url,
		),
		"utf8",
	),
);

function inside(root, path) {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
async function digest(path) {
	const hash = createHash("sha256");
	for await (const bytes of createReadStream(path)) hash.update(bytes);
	return hash.digest("hex");
}

/** Capture files and internal links without following directory links. This
 * same inventory verifies the copy and any previously published generation. */
async function inventory(root) {
	root = await realpath(root);
	const entries = [];
	async function visit(path) {
		for (const name of (await readdir(path)).sort()) {
			const item = join(path, name);
			const stat = await lstat(item);
			const entry = {
				path: relative(root, item).split(sep).join("/"),
				mode: stat.mode & 0o777,
			};
			if (stat.isSymbolicLink()) {
				const link = await readlink(item);
				if (
					isAbsolute(link) ||
					!inside(root, resolve(dirname(item), link)) ||
					!inside(root, await realpath(item))
				) {
					throw new Error("browser_installation_external_link");
				}
				entries.push({ ...entry, kind: "link", target: link });
			} else if (stat.isDirectory()) {
				entries.push({ ...entry, kind: "directory" });
				await visit(item);
			} else if (stat.isFile()) {
				entries.push({
					...entry,
					kind: "file",
					size: stat.size,
					sha256: await digest(item),
				});
			} else throw new Error("browser_installation_special_file");
		}
	}
	await visit(root);
	return entries;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Install into an explicit backend home. The activation file is the existing
 * BrowserService input; old generations remain available to running resources.
 * Material preservation is mechanical and does not grant distribution approval. */
export async function installBrowserRuntime(
	{ home, engine, chromium, chromiumExecutable, materials },
	{
		enginePin = metadata.platforms[`${process.platform}-${process.arch}`],
		copyDirectory = cp,
	} = {},
) {
	if (!enginePin) throw new Error("browser_engine_platform_unavailable");
	if (
		!home ||
		!engine ||
		!chromium ||
		!materials ||
		!chromiumExecutable ||
		isAbsolute(chromiumExecutable)
	) {
		throw new Error("browser_installation_input_invalid");
	}
	const source = {
		engine: await realpath(engine),
		chromium: await realpath(chromium),
		materials: await realpath(materials),
	};
	const selected = resolve(source.chromium, chromiumExecutable);
	if (
		!inside(source.chromium, selected) ||
		!inside(source.chromium, await realpath(selected))
	) {
		throw new Error("browser_installation_executable_invalid");
	}
	const executable = await lstat(selected);
	const engineStat = await lstat(source.engine);
	if (
		!executable.isFile() ||
		!(executable.mode & 0o111) ||
		!engineStat.isFile() ||
		!(engineStat.mode & 0o111)
	) {
		throw new Error("browser_installation_executable_invalid");
	}
	if (
		engineStat.size !== enginePin.size ||
		(await digest(source.engine)) !== enginePin.sha256
	) {
		throw new Error("browser_engine_pin_mismatch");
	}
	const inputs = {
		chromium: await inventory(source.chromium),
		materials: await inventory(source.materials),
	};
	if (!inputs.materials.some((entry) => entry.kind === "file"))
		throw new Error("browser_installation_materials_empty");
	const manifest = {
		schemaVersion: 1,
		engine: {
			name: metadata.name,
			version: metadata.version,
			sourceCommit: metadata.sourceCommit,
			size: enginePin.size,
			sha256: enginePin.sha256,
		},
		chromiumExecutable: relative(source.chromium, selected)
			.split(sep)
			.join("/"),
		...inputs,
	};
	const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
	const generation = createHash("sha256").update(encoded).digest("hex");
	await mkdir(resolve(home), { recursive: true, mode: 0o700 });
	const root = join(await realpath(home), "browser");
	// Input directories must not contain the output tree: cp must never recurse
	// into its own work or capture a live backend profile as package material.
	if ([source.chromium, source.materials].some((path) => inside(path, root)))
		throw new Error("browser_installation_input_overlap");
	const versions = join(root, "versions");
	await mkdir(versions, { recursive: true, mode: 0o700 });
	const temporary = await mkdtemp(join(versions, ".install-"));
	const activation = join(root, `.installation-${randomUUID()}.tmp`);
	const destination = join(versions, generation);
	try {
		await copyFile(source.engine, join(temporary, "engine"));
		await chmod(join(temporary, "engine"), 0o755);
		await copyDirectory(source.chromium, join(temporary, "chromium"), {
			recursive: true,
			verbatimSymlinks: true,
		});
		await copyDirectory(source.materials, join(temporary, "materials"), {
			recursive: true,
			verbatimSymlinks: true,
		});
		if (
			(await digest(join(temporary, "engine"))) !== enginePin.sha256 ||
			!same(await inventory(join(temporary, "chromium")), inputs.chromium) ||
			!same(await inventory(join(temporary, "materials")), inputs.materials)
		) {
			throw new Error("browser_installation_source_changed");
		}
		await writeFile(join(temporary, "manifest.json"), encoded, {
			flag: "wx",
			mode: 0o600,
		});
		try {
			await rename(temporary, destination);
		} catch (error) {
			if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
			// Never repair a generation in place: a running browser may still own it.
			if (
				(await readFile(join(destination, "manifest.json"), "utf8")) !==
					encoded ||
				(await digest(join(destination, "engine"))) !== enginePin.sha256 ||
				!same(
					await inventory(join(destination, "chromium")),
					inputs.chromium,
				) ||
				!same(await inventory(join(destination, "materials")), inputs.materials)
			) {
				throw new Error("browser_installation_generation_changed");
			}
		}
		const installation = {
			engineExecutable: join(destination, "engine"),
			chromiumExecutable: join(
				destination,
				"chromium",
				...manifest.chromiumExecutable.split("/"),
			),
		};
		const file = await open(activation, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(installation, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(activation, join(root, "installation.json"));
		return {
			generation,
			installation,
			manifest: join(destination, "manifest.json"),
			materials: join(destination, "materials"),
		};
	} finally {
		await rm(temporary, { recursive: true, force: true });
		await unlink(activation).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
