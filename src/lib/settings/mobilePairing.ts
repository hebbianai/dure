/**
 * 설정 → 모바일이 고르는 값들. Figma `dure-UI` 3326:87446 / 87594 / 87746.
 *
 * 화면에서 뺀 이유는 둘 다 판단이기 때문이다 — 어느 주소를 폰에게 알릴지, 어느
 * 링크를 QR로 그릴지. 컴포넌트 안에 있으면 렌더 없이는 확인할 수 없다.
 */

import type { NetworkChoice } from "@/lib/ipc";

export type MobilePlatform = "ios" | "android";

/**
 * 폰이 앱을 받는 곳.
 *
 * 아직 두 플랫폼이 같은 곳을 가리킨다 — 이 앱은 스토어에 없고, 지금 실제로 앱이
 * 놓이는 자리는 릴리스 피드 하나다(랜딩의 내려받기 버튼과 같은 주소). 스토어가
 * 생기면 고칠 곳은 이 표 한 줄이고, 탭·QR·복사는 이미 플랫폼별로 갈라져 있다.
 */
export const MOBILE_INSTALL_URL: Record<MobilePlatform, string> = {
	ios: "https://github.com/hebbianai/hebbian-releases/releases/latest",
	android: "https://github.com/hebbianai/hebbian-releases/releases/latest",
};

/**
 * 폰에게 알릴 주소.
 *
 * Tailscale 주소와 `bridge*`(도커·VM이 만드는 가상 인터페이스)를 뒤로 미룬다.
 * 둘 다 이 기계의 진짜 주소지만 폰이 같은 망에 있어도 닿지 않는 경우가 흔하고,
 * 첫 페어링이 실패하면 사용자는 그 이유를 화면에서 알 수 없다. 하나도 남지
 * 않으면 첫 번째라도 돌려준다 — 주소 없이 만든 제안은 백엔드가 거절한다.
 */
export function preferredPairingAddress(networks: readonly NetworkChoice[]): string {
	const direct = networks.find(
		(network) => !network.tailnet && !network.interface.startsWith("bridge"),
	);
	return (direct ?? networks[0])?.address ?? "";
}

/**
 * 문장 안에 버튼 하나를 넣기 위한 쪼개기.
 *
 * "또는 {link}로 폰에 직접 보내세요."처럼 링크가 문장 *가운데* 있는 카피가
 * 있고, 어순은 언어마다 다르다. 세 개의 키로 이어 붙이면 번역자가 어순을 바꿀
 * 수 없다 — 한 문장을 자리표시자로 두고 여기서 앞뒤로 가른다.
 */
export function splitAroundPlaceholder(
	sentence: string,
	placeholder = "{link}",
): { before: string; after: string } {
	const at = sentence.indexOf(placeholder);
	// 자리표시자가 없는 번역은 문장을 통째로 앞에 둔다. 링크가 사라지는 편이
	// 문장이 깨지는 것보다 낫고, 그 상태는 카탈로그를 고치면 끝난다.
	if (at < 0) return { before: sentence, after: "" };
	return {
		before: sentence.slice(0, at),
		after: sentence.slice(at + placeholder.length),
	};
}
