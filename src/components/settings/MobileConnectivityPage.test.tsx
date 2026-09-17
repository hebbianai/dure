// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { hubDeviceRevoke, hubDevices, hubPairingOffer, mobilePairingNetworks, mobilePairingQr } =
	vi.hoisted(() => ({
		hubDeviceRevoke: vi.fn(
			async (): Promise<{
				revoked: boolean;
				failures: { name: string; failure: string }[];
			}> => ({ revoked: true, failures: [] }),
		),
		hubDevices: vi.fn(async () => [] as { device_id: string; label: string }[]),
		hubPairingOffer: vi.fn(
			async (_label: string, _address: string, _relay: string) => ({
				payload: "dure-hub:3?o=abc",
				device_id: "phone-1",
			}),
		),
		mobilePairingNetworks: vi.fn(async () => [
			{ address: "100.64.1.2", interface: "utun3", tailnet: true },
			{ address: "192.168.0.11", interface: "en0", tailnet: false },
		]),
		mobilePairingQr: vi.fn(async () => ({ size: 1, modules: [true] })),
	}));
const { writeText } = vi.hoisted(() => ({ writeText: vi.fn(async (_text: string) => {}) }));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));

vi.mock("@/lib/ipc", () => ({
	hubDeviceRevoke,
	hubDevices,
	hubPairingOffer,
	mobilePairingNetworks,
	mobilePairingQr,
}));

vi.mock("@/lib/scheduling/maintenanceLaneInterval", () => ({
	setMaintenanceLaneInterval: (callback: () => void, delay: number) =>
		setInterval(callback, delay),
	clearMaintenanceLaneInterval: (timer: ReturnType<typeof setInterval>) =>
		clearInterval(timer),
}));

import { MobileConnectivityPage } from "./MobileConnectivityPage";

afterEach(() => {
	cleanup();
	writeText.mockReset();
	hubDeviceRevoke.mockReset();
	hubPairingOffer.mockReset();
	mobilePairingQr.mockReset();
	hubDevices.mockReset();
	hubDevices.mockResolvedValue([]);
});

describe("설정 → 모바일", () => {
	it("copies the current offer and leaves pairing only on Done without revoking it", async () => {
		const registered = [{ device_id: "existing-1", label: "Existing phone" }];
		hubDevices.mockImplementation(async () => [...registered]);
		hubPairingOffer.mockImplementationOnce(async () => {
			registered.push({ device_id: "phone-1", label: "New phone" });
			return { device_id: "phone-1", payload: "dure-hub:3?o=exact-offer" };
		});
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: /다른 장치와 페어링/ }));
		await screen.findByRole("img", { name: "페어링 QR" });

		fireEvent.click(screen.getByRole("button", { name: "페어링 코드 복사" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("dure-hub:3?o=exact-offer"));
		fireEvent.click(screen.getByRole("button", { name: "완료" }));
		expect(await screen.findByText("New phone")).toBeTruthy();
		expect(screen.queryByRole("img", { name: "페어링 QR" })).toBeNull();
		expect(hubDeviceRevoke).not.toHaveBeenCalled();
		expect(hubPairingOffer).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: /다른 장치와 페어링/ }));
		await waitFor(() => expect(hubPairingOffer).toHaveBeenCalledTimes(2));
		expect(hubDeviceRevoke).not.toHaveBeenCalled();
	});

	it("reports a failed pairing-code copy while retaining the QR for retry", async () => {
		writeText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));
		await screen.findByRole("img", { name: "페어링 QR" });
		fireEvent.click(screen.getByRole("button", { name: "페어링 코드 복사" }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByRole("img", { name: "페어링 QR" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "페어링 코드 복사" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
	});

	it.each(["reported", "thrown"])(
		"retries the same offer after a %s regeneration revocation failure",
		async (failure) => {
			if (failure === "reported") {
				hubDeviceRevoke.mockResolvedValueOnce({
					revoked: false,
					failures: [{ name: "build box", failure: "Offline" }],
				});
			} else {
				hubDeviceRevoke.mockRejectedValueOnce(new Error("build box Offline"));
			}
			hubDeviceRevoke.mockResolvedValueOnce({ revoked: true, failures: [] });
			render(<MobileConnectivityPage />);
			fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));
			await screen.findByRole("img", { name: "페어링 QR" });

			fireEvent.click(screen.getByRole("button", { name: /코드 재생성/ }));
			await screen.findByText(/build box/);
			expect(hubPairingOffer).toHaveBeenCalledTimes(1);

			fireEvent.click(screen.getByRole("button", { name: /코드 재생성/ }));
			await waitFor(() => expect(hubPairingOffer).toHaveBeenCalledTimes(2));
			expect(hubDeviceRevoke.mock.calls).toEqual([["phone-1"], ["phone-1"]]);
		},
	);

	it("keeps the issued QR visible until the user finishes pairing on the phone", async () => {
		const registered: { device_id: string; label: string }[] = [];
		hubDevices.mockImplementation(async () => [...registered]);
		hubPairingOffer.mockImplementationOnce(async () => {
			// Issuing an offer registers its credential before any phone connects.
			registered.push({ device_id: "phone-1", label: "내 폰" });
			return { payload: "dure-hub:3?o=abc", device_id: "phone-1" };
		});
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));
		await screen.findByRole("img", { name: "페어링 QR" });

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 2100));
		});

		expect(screen.queryByRole("img", { name: "페어링 QR" })).not.toBeNull();
		expect(screen.queryByText("등록된 기기")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "완료" }));
		expect(await screen.findByText("내 폰")).toBeTruthy();
		expect(screen.queryByRole("img", { name: "페어링 QR" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /다른 장치와 페어링/ }));
		await screen.findByRole("img", { name: "페어링 QR" });
		expect(hubPairingOffer).toHaveBeenCalledTimes(2);
	});

	/** 등록된 폰이 없으면 앱을 받는 단계부터다 (Figma 3326:87446). */
	it("기기가 없으면 1/2 설치 단계를 그린다", async () => {
		render(<MobileConnectivityPage />);

		expect(await screen.findByText("앱을 받고 페어링하세요.")).toBeTruthy();
		expect(screen.getByRole("radio", { name: "iOS" })).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Android" })).toBeTruthy();
	});

	/**
	 * 제안 한 번이 허브 켜기·릴레이 등록까지 끌고 간다 — 화면에 스위치가 없는
	 * 것은 백엔드가 그 일을 하기 때문이지, 빠뜨린 것이 아니다.
	 */
	it("페어링으로 넘어가면 실제 랜 주소로 제안을 한 번 만든다", async () => {
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));

		await waitFor(() => expect(hubPairingOffer).toHaveBeenCalledTimes(1));
		// 테일넷 주소가 먼저 왔지만 폰이 닿는 것은 랜 주소다.
		expect(hubPairingOffer.mock.calls[0][1]).toBe("192.168.0.11");
		expect(await screen.findByText("휴대폰에서 Dure Mobile을 여세요.")).toBeTruthy();
	});

	/** 등록된 폰이 있으면 마법사가 아니라 목록이다 (Figma 3326:87746). */
	it("등록된 기기가 있으면 목록을 그리고, 등록 해제가 그 기기를 지운다", async () => {
		hubDevices.mockResolvedValue([{ device_id: "phone-1", label: "내 폰" }]);
		render(<MobileConnectivityPage />);

		expect(await screen.findByText("등록된 기기")).toBeTruthy();
		expect(screen.getByText("내 폰")).toBeTruthy();
		expect(screen.queryByText("앱을 받고 페어링하세요.")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "등록 해제" }));
		await waitFor(() =>
			expect(hubDeviceRevoke).toHaveBeenCalledWith("phone-1", false),
		);
	});

	/**
	 * 해지는 서버들을 ssh 로 돈다 — 허브 토큰 하나를 지우는 일이 아니다.
	 * 도는 동안 버튼이 그대로면 사용자는 아무 일도 안 일어난 줄 알고 다시
	 * 누르고, 실패를 삼키면 서버에 키가 남은 채 목록에서만 사라진다.
	 */
	it("해지가 도는 동안 잠기고, 실패하면 그 사유를 말한다", async () => {
		hubDevices.mockResolvedValue([{ device_id: "phone-1", label: "내 폰" }]);
		let finish: (() => void) | undefined;
		hubDeviceRevoke.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					finish = () => reject(new Error("서버의 키를 지우지 못했습니다: build box"));
				}),
		);
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: "등록 해제" }));

		const running = await screen.findByRole("button", { name: "해제하는 중…" });
		expect((running as HTMLButtonElement).disabled).toBe(true);

		finish?.();

		expect(
			await screen.findByText(/서버의 키를 지우지 못했습니다: build box/),
		).toBeTruthy();
		// 실패한 기기는 목록에 남는다: 서버가 돌아오면 다시 누를 수 있어야 한다.
		expect(screen.getByText("내 폰")).toBeTruthy();
		expect(screen.getByRole("button", { name: "등록 해제" })).toBeTruthy();
	});

	it("도달하지 못한 서버와 원인을 보여주고 기록 포기는 다시 확인한다", async () => {
		hubDevices.mockResolvedValue([{ device_id: "phone-1", label: "내 폰" }]);
		hubDeviceRevoke
			.mockResolvedValueOnce({
				revoked: false,
				failures: [
					{
						name: "build box",
						failure: "Load key /old-key.pem: Operation not permitted",
					},
				],
			})
			.mockResolvedValueOnce({
				revoked: false,
				failures: [
					{
						name: "build box",
						failure: "Load key /old-key.pem: Operation not permitted",
					},
				],
			});
		render(<MobileConnectivityPage />);

		fireEvent.click(await screen.findByRole("button", { name: "등록 해제" }));

		expect(await screen.findByText(/build box/)).toBeTruthy();
		expect(hubDeviceRevoke).toHaveBeenCalledWith("phone-1", false);
		expect(screen.getByText(/Operation not permitted/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "기록만 지우기" }));
		expect(
			await screen.findByText("서버에 키가 남아 있어도 이 기기 기록을 지울까요?"),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "그래도 등록 해제" }));

		await waitFor(() =>
			expect(hubDeviceRevoke).toHaveBeenLastCalledWith("phone-1", true),
		);
		await waitFor(() =>
			expect(
				screen.queryByText("서버에 키가 남아 있어도 이 기기 기록을 지울까요?"),
			).toBeNull(),
		);
	});

	/**
	 * `hub_pairing_offer`는 부를 때마다 기기를 하나 등록한다. 뒤로 갔다 오는
	 * 것만으로 새 제안을 만들면, 아무도 쓰지 않은 기기가 목록에 쌓인다.
	 */
	it("2단계를 다시 열어도 제안을 새로 만들지 않는다", async () => {
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));
		await waitFor(() => expect(hubPairingOffer).toHaveBeenCalledTimes(1));

		fireEvent.click(screen.getByRole("button", { name: /뒤로/ }));
		fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));

		expect(await screen.findByText("휴대폰에서 Dure Mobile을 여세요.")).toBeTruthy();
		expect(hubPairingOffer).toHaveBeenCalledTimes(1);
	});

	/** 코드 재생성은 새 기기를 등록한다 — 앞의 것은 지우고 간다. */
	it("코드 재생성은 앞선 제안의 기기를 지운 뒤 새로 만든다", async () => {
		render(<MobileConnectivityPage />);
		fireEvent.click(await screen.findByRole("button", { name: /이 컴퓨터와 페어링/ }));
		// 코드가 화면에 뜬 **뒤에** 누른다 — 그 전에는 지울 기기가 아직 없다.
		await screen.findByRole("img", { name: "페어링 QR" });

		fireEvent.click(screen.getByRole("button", { name: /코드 재생성/ }));

		await waitFor(() => expect(hubPairingOffer).toHaveBeenCalledTimes(2));
		expect(hubDeviceRevoke).toHaveBeenCalledWith("phone-1");
	});

	/** 목록에서 '다른 장치와 페어링'은 설치 단계를 건너뛰고 코드로 간다. */
	it("다른 장치와 페어링은 곧장 2/2로 간다", async () => {
		hubDevices.mockResolvedValue([{ device_id: "phone-1", label: "내 폰" }]);
		render(<MobileConnectivityPage />);

		fireEvent.click(await screen.findByRole("button", { name: /다른 장치와 페어링/ }));

		expect(await screen.findByText("이 컴퓨터와 페어링")).toBeTruthy();
		await waitFor(() => expect(hubPairingOffer).toHaveBeenCalledTimes(1));
	});
});
