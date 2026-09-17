import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeBack } from "./nativeBack";

const bridge = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ onBackButtonPress: bridge.register }));
let handler: (() => void) | undefined;
let release: (() => void) | undefined;
let back: ReturnType<typeof createNativeBack>;
const unregister = vi.fn(async () => {
	handler = undefined;
});

beforeEach(() => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
	handler = undefined;
	release = undefined;
	unregister.mockClear();
	bridge.register
		.mockReset()
		.mockImplementation(async (callback: () => void) => {
			handler = callback;
			return { unregister };
		});
	back = createNativeBack();
});
afterEach(async () => {
	back.dispose();
	release?.();
	await vi.waitFor(() => expect(handler).toBeUndefined());
	vi.restoreAllMocks();
});

it("uses the newest rendered action without registering another native listener", async () => {
	const old = vi.fn();
	const current = vi.fn();
	back.bind(old);
	back.commit();
	await vi.waitFor(() => expect(handler).toBeTypeOf("function"));
	back.begin();
	back.bind(current);
	back.commit();
	handler?.();
	expect(old).not.toHaveBeenCalled();
	expect(current).toHaveBeenCalledOnce();
	expect(bridge.register).toHaveBeenCalledOnce();
});

it("gives the top layer priority and consumes Back while that layer is busy", async () => {
	const screen = vi.fn();
	const cancel = vi.fn();
	back.bind(screen);
	expect(back.bind(cancel, true)).toBe(cancel);
	back.commit();
	await vi.waitFor(() => expect(handler).toBeTypeOf("function"));
	handler?.();
	expect(cancel).not.toHaveBeenCalled();
	expect(screen).not.toHaveBeenCalled();
	back.begin();
	back.bind(screen);
	back.bind(cancel);
	back.commit();
	handler?.();
	expect(cancel).toHaveBeenCalledOnce();
});

it.each(["home", "dispose"] as const)(
	"removes a late native registration after %s",
	async (target) => {
		bridge.register.mockImplementation(async (callback: () => void) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			handler = callback;
			return { unregister };
		});
		const action = vi.fn();
		back.bind(action);
		back.commit();
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		if (target === "dispose") back.dispose();
		else {
			back.begin();
			back.commit();
		}
		release?.();
		await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
		expect(handler).toBeUndefined();
		expect(action).not.toHaveBeenCalled();
	},
);

it("leaves non-Android platforms on their existing navigation path", async () => {
	vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
	back = createNativeBack();
	back.bind(vi.fn());
	back.commit();
	await Promise.resolve();
	expect(bridge.register).not.toHaveBeenCalled();
});
