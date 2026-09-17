// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	ensureProjectForPath: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./useSshHostDialogsState", () => ({
	useAddRemoteProjectDialogState: () => ({
		host: {
			id: "windows",
			name: "Windows",
			host: "windows.test",
			user: "dev",
			auth: "auto",
		},
		ensureProjectForPath: mocks.ensureProjectForPath,
	}),
}));

import { t } from "@/lib/i18n";
import { AddRemoteProjectDialog } from "./SshHostDialogs";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
function listing(path: string, names = ["Documents", "Downloads"]) {
	return {
		path,
		isRepo: false,
		entries: names.map((name) => ({
			name,
			path: `${path}/${name}`,
			isDir: true,
			isRepo: false,
		})),
	};
}
function result(command: string, path: string, names?: string[]) {
	return command === "ssh_exec_once"
		? {
				code: 0,
				stdout: `${path}\n__NOGIT__\n${(names ?? ["Documents", "Downloads"]).map((name) => `${name}/`).join("\n")}\n`,
				stderr: "",
			}
		: listing(path, names);
}
beforeEach(() => {
	vi.useFakeTimers();
	mocks.invoke.mockReset();
	mocks.ensureProjectForPath.mockReset();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});
async function tick(ms = 0) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

it("opens only the remote home while the first lookup is pending", async () => {
	mocks.invoke.mockReturnValue(new Promise(() => {}));
	render(<AddRemoteProjectDialog hostId="windows" onClose={vi.fn()} />);
	await tick(300);
	expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("shows a connection failure without claiming the folder is empty", async () => {
	mocks.invoke.mockRejectedValue(new Error("handshake: timed out"));
	render(<AddRemoteProjectDialog hostId="windows" onClose={vi.fn()} />);
	await tick();
	expect(screen.getByText(/handshake: timed out/)).toBeTruthy();
	expect(screen.queryByText(t("ssh.projectBrowser.empty"))).toBeNull();
	expect(
		screen
			.getByRole("button", { name: t("ssh.projectBrowser.openFolder") })
			.hasAttribute("disabled"),
	).toBe(true);
});

it("does not let a late failed lookup replace a newer successful navigation", async () => {
	const older = deferred<unknown>();
	mocks.invoke
		.mockImplementationOnce((command) =>
			Promise.resolve(result(command, "/home/dev")),
		)
		.mockImplementationOnce(() => older.promise)
		.mockImplementation((command) =>
			Promise.resolve(result(command, "/new", ["current-folder"])),
		);
	render(<AddRemoteProjectDialog hostId="windows" onClose={vi.fn()} />);
	await tick(300);
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "/old/" } });
	await tick(300);
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "/new/" } });
	await tick(300);
	expect(screen.getByRole("button", { name: "current-folder" })).toBeTruthy();
	await act(async () => {
		older.reject(new Error("old lookup timed out"));
	});
	expect(screen.queryByText(/old lookup timed out/)).toBeNull();
	expect(screen.getByRole("button", { name: "current-folder" })).toBeTruthy();
});

it("disables stale folder selection after a failed navigation", async () => {
	mocks.invoke
		.mockImplementationOnce((command) =>
			Promise.resolve(result(command, "/home/dev")),
		)
		.mockRejectedValue(new Error("permission denied"));
	render(<AddRemoteProjectDialog hostId="windows" onClose={vi.fn()} />);
	await tick(300);
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "/denied/" },
	});
	await tick(300);
	expect(
		screen
			.getByRole("button", { name: t("ssh.projectBrowser.openFolder") })
			.hasAttribute("disabled"),
	).toBe(true);
});

it("filters Windows paths, enters a folder, and registers the resolved directory", async () => {
	mocks.invoke.mockImplementation((_command, args) =>
		Promise.resolve(
			args.path === "C:/Users/dev/Documents"
				? listing(args.path, ["work"])
				: listing("C:/Users/dev"),
		),
	);
	const project = { id: "chosen", path: "C:/Users/dev/Documents" };
	mocks.ensureProjectForPath.mockResolvedValue(project);
	const onResolved = vi.fn();
	const onClose = vi.fn();
	render(
		<AddRemoteProjectDialog
			hostId="windows"
			onClose={onClose}
			onResolved={onResolved}
		/>,
	);
	await tick();
	fireEvent.change(screen.getByRole("textbox"), {
		target: { value: "C:\\Users\\dev\\Doc" },
	});
	await tick(300);
	expect(mocks.invoke).toHaveBeenCalledTimes(1);
	expect(screen.queryByRole("button", { name: "Downloads" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Documents" }));
	await tick();
	expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
		"C:/Users/dev/Documents/",
	);
	fireEvent.click(
		screen.getByRole("button", { name: t("ssh.projectBrowser.openFolder") }),
	);
	await tick();
	expect(mocks.ensureProjectForPath).toHaveBeenCalledWith(
		"C:/Users/dev/Documents",
		"windows",
	);
	expect(onResolved).toHaveBeenCalledWith(project);
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("invalidates a pending result as soon as a new path is typed", async () => {
	const older = deferred<unknown>();
	mocks.invoke
		.mockImplementationOnce(() => Promise.resolve(listing("/home/dev")))
		.mockReturnValueOnce(older.promise)
		.mockResolvedValue(listing("/new", ["new-folder"]));
	render(<AddRemoteProjectDialog hostId="windows" onClose={vi.fn()} />);
	await tick();
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "/old/" } });
	await tick(300);
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "/new/" } });
	await act(async () => {
		older.resolve(listing("/old", ["old-folder"]));
	});
	expect(screen.queryByRole("button", { name: "old-folder" })).toBeNull();
	expect(
		screen
			.getByRole("button", { name: t("ssh.projectBrowser.openFolder") })
			.hasAttribute("disabled"),
	).toBe(true);
	await tick(300);
	expect(screen.getByRole("button", { name: "new-folder" })).toBeTruthy();
});

it("can retry project registration without reloading a valid listing", async () => {
	mocks.invoke.mockResolvedValue(listing("/home/dev"));
	mocks.ensureProjectForPath
		.mockRejectedValueOnce(new Error("connection lost during registration"))
		.mockResolvedValue({ id: "chosen" });
	const onClose = vi.fn();
	render(<AddRemoteProjectDialog hostId="windows" onClose={onClose} />);
	await tick();
	fireEvent.click(
		screen.getByRole("button", { name: t("ssh.projectBrowser.openFolder") }),
	);
	await tick();
	expect(screen.getByText(/connection lost during registration/)).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: t("ssh.projectBrowser.openFolder") }),
	);
	await tick();
	expect(mocks.ensureProjectForPath).toHaveBeenCalledTimes(2);
	expect(onClose).toHaveBeenCalledTimes(1);
});
