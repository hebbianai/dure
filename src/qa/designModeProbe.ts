/**
 * Design Mode B단계 실기 프로브.
 *
 * 답해야 하는 질문 하나: **Tauri 안에서** 원격 페이지(사용자 앱)에 낀 우리 오리진
 * 브리지 프레임이 IPC를 쓸 수 있는가. 클릭 없이도 증명된다 — 주입 스크립트가 로드
 * 시 보내는 cancel(navigation)이 도착하면 채널이 통한 것이다.
 *
 * 실행: `echo "designmode:http://localhost:1443" > qa.autorun` 후 dev 앱 기동.
 * 결과는 qa.log에 남는다.
 *
 * 트리거가 qa.ts가 아니라 main.tsx에 있는 이유: qa.ts는 god-file 라쳇 상한(1609)에
 * 닿아 있어 한 줄도 늘릴 수 없다. 그래서 이 모듈이 플래그를 직접 읽는다.
 */

import { openDesignModeBrowser } from "@/lib/design/designModeBrowser";
import { subscribeDesignModeCaptures } from "@/lib/design/designModeCaptureEvents";
import { qaLog } from "@/qa";

/** 플래그에서 대상 URL을 뽑는다 — `designmode:<url>` 형식. */
export function designModeProbeUrl(flag: string): string | undefined {
	const match = flag.match(/designmode:(\S+)/);
	return match?.[1];
}

/** dev에서만 호출된다. 플래그에 designmode가 없으면 아무 일도 하지 않는다. */
export async function maybeRunDesignModeProbe(): Promise<void> {
	let flag = "";
	try {
		flag = (await (await fetch("/__qa_flag")).text()).trim();
	} catch {
		return; // dev 서버에 플러그인이 없는 경우
	}
	if (!flag.includes("designmode")) return;
	await runDesignModeProbe(flag);
}

export async function runDesignModeProbe(flag: string): Promise<void> {
	const url = designModeProbeUrl(flag) ?? "http://localhost:1443";
	qaLog("designmode", { phase: "start", url });
	// 구독을 먼저 켠다 — 창이 먼저 열리면 navigation 신호를 놓친다.
	subscribeDesignModeCaptures();
	const seen: unknown[] = [];
	const stop = await import("@tauri-apps/api/event").then(({ listen }) =>
		listen("dure://design-mode/capture", (event) => {
			seen.push(event.payload);
			qaLog("designmode", { phase: "capture", payload: event.payload });
		}),
	);
	try {
		// 자동 픽으로 pick 경로까지 확인한다 — 창 안 UI를 구동할 수단이 없다.
		const opened = await openDesignModeBrowser(url, "button.save");
		qaLog("designmode", { phase: "opened", ...opened });
	} catch (error) {
		qaLog("designmode", { phase: "open_failed", error: String(error) });
		stop();
		return;
	}
	// 브리지 준비 타임아웃(2.5초)보다 넉넉히 기다린다.
	await new Promise((resolve) => setTimeout(resolve, 6000));
	qaLog("designmode", {
		phase: "done",
		received: seen.length,
		// 이것이 결론이다: 하나라도 도착했다면 원격 페이지 안의 우리 프레임이 IPC를
		// 쓸 수 있다는 뜻이다.
		ipcReachedFromRemotePage: seen.length > 0,
	});
	stop();
}
