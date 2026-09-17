import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateFeedbackDeviceId } from "@/lib/feedback/deviceId";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
	data: Record<string, string>;
} {
	const data: Record<string, string> = {};
	return {
		data,
		getItem: (key) => (key in data ? data[key] : null),
		setItem: (key, value) => {
			data[key] = value;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getOrCreateFeedbackDeviceId", () => {
	it("creates and persists a UUID-shaped id on first use", () => {
		const storage = memoryStorage();
		const id = getOrCreateFeedbackDeviceId(storage);
		expect(id).toMatch(UUID_PATTERN);
		expect(storage.data["agent-ide-feedback-device-id-v1"]).toBe(id);
	});

	it("reuses the persisted id on later calls", () => {
		const storage = memoryStorage();
		const first = getOrCreateFeedbackDeviceId(storage);
		const second = getOrCreateFeedbackDeviceId(storage);
		expect(second).toBe(first);
	});

	it("still returns a UUID-shaped id when storage reads and writes both throw", () => {
		const storage = {
			getItem: vi.fn(() => {
				throw new Error("SecurityError");
			}),
			setItem: vi.fn(() => {
				throw new Error("QuotaExceededError");
			}),
		};
		const id = getOrCreateFeedbackDeviceId(storage);
		expect(id).toMatch(UUID_PATTERN);
	});

	it("still returns a UUID-shaped id when crypto.randomUUID throws", () => {
		vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
			throw new Error("randomUUID requires a secure context");
		});
		const storage = memoryStorage();
		const id = getOrCreateFeedbackDeviceId(storage);
		expect(id).toMatch(UUID_PATTERN);
		expect(storage.data["agent-ide-feedback-device-id-v1"]).toBe(id);
	});
});
