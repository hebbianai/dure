import { describe, expect, it } from "vitest";
import {
	MOBILE_INSTALL_URL,
	preferredPairingAddress,
	splitAroundPlaceholder,
} from "./mobilePairing";

const network = (address: string, iface: string, tailnet = false) => ({
	address,
	interface: iface,
	tailnet,
});

describe("preferredPairingAddress", () => {
	/** 테일넷 주소로 페어링한 폰은 같은 와이파이에서도 닿지 않는 일이 흔하다. */
	it("테일넷과 브리지보다 실제 랜 주소를 먼저 고른다", () => {
		expect(
			preferredPairingAddress([
				network("100.64.1.2", "utun3", true),
				network("192.168.0.14", "bridge100"),
				network("192.168.0.11", "en0"),
			]),
		).toBe("192.168.0.11");
	});

	/** 주소 없이 만든 제안은 백엔드가 거절한다 — 하나뿐이면 그거라도 준다. */
	it("고를 것이 테일넷뿐이면 그것을 준다", () => {
		expect(preferredPairingAddress([network("100.64.1.2", "utun3", true)])).toBe(
			"100.64.1.2",
		);
	});

	it("아무 주소도 없으면 빈 문자열", () => {
		expect(preferredPairingAddress([])).toBe("");
	});
});

describe("splitAroundPlaceholder", () => {
	it("문장 가운데의 자리표시자를 앞뒤로 가른다", () => {
		expect(splitAroundPlaceholder("또는 {link}로 폰에 직접 보내세요.")).toEqual({
			before: "또는 ",
			after: "로 폰에 직접 보내세요.",
		});
	});

	/** 링크 하나가 빠지는 편이 문장이 깨지는 것보다 낫다. */
	it("자리표시자가 없는 번역은 문장을 그대로 앞에 둔다", () => {
		expect(splitAroundPlaceholder("Send it to your phone.")).toEqual({
			before: "Send it to your phone.",
			after: "",
		});
	});
});

describe("MOBILE_INSTALL_URL", () => {
	it("두 플랫폼 모두 실제로 존재하는 주소를 가리킨다", () => {
		for (const url of Object.values(MOBILE_INSTALL_URL)) {
			expect(url).toMatch(/^https:\/\//);
		}
	});
});
