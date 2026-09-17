// ipc/core — 백엔드 capability·호환성 프로브 + 시스템 하드웨어.
//
// ipc.ts 도메인 분할 1단계(2026-08-01): 내용은 구 src/lib/ipc.ts에서 그대로
// 옮겨졌고, 소비자는 barrel(src/lib/ipc.ts)을 통해 기존 경로를 유지한다.
// invoke 래퍼는 이 디렉토리에만 둔다(architecture fitness 게이트가 강제).
// transports가 raw 채널을 쓸 때 tauri api 직접 import 대신 이 재수출을
// 쓴다 — invoke-outside-ipc 경계 유지(IPC 표면은 ipc 모듈 소유).
export { Channel, convertFileSrc, isTauri } from "@tauri-apps/api/core";
export type TauriCoreModule = typeof import("@tauri-apps/api/core");
import { invoke } from "@tauri-apps/api/core";
import { frontendRuntimeObservation } from "@/lib/platform/frontendRuntimeObservation";
import {
	type AppCompatibility,
	BACKEND_FEATURES,
	type BackendCapabilities,
	backendCapabilitiesSupport,
	classifyAppCompatibility,
} from "@/lib/platform/backendCompatibility";

export type { AppCompatibility, BackendCapabilities };
export { BACKEND_FEATURES };

export interface SystemHardwareProfile {
	logicalCores?: number;
	physicalMemoryBytes?: number;
}

export const systemHardwareProfile = () =>
	invoke<SystemHardwareProfile>("system_hardware_profile");

/** Storage selected by the running native app, shared by its additional windows. */
export const webviewStorageOptions = () =>
	invoke<{ dataStoreIdentifier?: number[]; dataDirectory?: string }>(
		"webview_storage_options",
	);

let backendCapabilitiesPromise: Promise<BackendCapabilities | null> | undefined;

export function backendCapabilities(
	refresh = false,
): Promise<BackendCapabilities | null> {
	if (refresh || !backendCapabilitiesPromise) {
		backendCapabilitiesPromise = invoke<BackendCapabilities>("app_caps").catch(
			() => null,
		);
	}
	return backendCapabilitiesPromise;
}

export async function appCompatibility(
	refresh = false,
): Promise<AppCompatibility> {
	return classifyAppCompatibility(
		frontendRuntimeObservation,
		await backendCapabilities(refresh),
	);
}

export async function backendSupports(feature: string): Promise<boolean> {
	const capabilities = await backendCapabilities();
	return backendCapabilitiesSupport(capabilities, feature);
}
