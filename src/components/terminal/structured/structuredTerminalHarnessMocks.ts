/**
 * Shared mock state for the StructuredTerminalView suites, extracted as a leaf
 * module so both the harness and its pull helpers can depend on it without a
 * cycle. `vi.mock` factory bodies stay in the harness.
 */
import { vi } from "vitest";
import { StructuredTerminalRecoveryAdmission } from "@/lib/terminal/structuredTerminalRecoveryAdmission";

export const protocolMocks = { decodeCalls: 0 };
export const mocks = {
	attach: vi.fn(),
	remoteCatalog: vi.fn(),
	remoteKnownHostTrust: vi.fn(),
	detach: vi.fn(async (_observerId: string) => undefined),
	send: vi.fn(async (_observerId: string, _record: Uint8Array) => "record-1"),
	measure: vi.fn(
		(
			width: number,
			height: number,
			_fontFamily: string,
			_fontSize: number,
			_lineHeight: number,
		) => ({
			cellWidth: 10,
			rowHeight: 20,
			columns: Math.max(1, Math.floor(width / 10)),
			rows: Math.max(1, Math.floor(height / 20)),
			asciiRunCapability: "fixed_cell_advance" as const,
		}),
	),
	invalidateMetrics: vi.fn(),
	readClipboardImage: vi.fn(),
	readClipboardText: vi.fn(),
	saveTempImage: vi.fn(),
	saveTempFiles: vi.fn(),
	uploadSshFilesToTemp: vi.fn(),
	routeSessionFiles: vi.fn(),
	writeClipboard: vi.fn(async () => undefined),
	showToast: vi.fn(),
	setHmuxSessionMetadata: vi.fn(),
	setSessionAgent: vi.fn(),
	setSessionAgentPin: vi.fn(),
	setSessionAgentRuntimeState: vi.fn(),
	setSessionCwd: vi.fn(),
	setSessionTitle: vi.fn(),
	recoveryAdmission: new StructuredTerminalRecoveryAdmission(),
	desktopId: undefined as string | undefined,
	workspaceActive: true,
	bindLargeViewReturnSource: vi.fn(),
	largeViewReturnComplete: vi.fn(),
	largeViewReturnDispose: vi.fn(),
	largeViewReturnConceal: vi.fn(),
	largeViewReturnPrepare: undefined as
		| ((generation: string) => boolean)
		| undefined,
	largeViewReturnRetired: undefined as
		| ((generation: string) => void)
		| undefined,
	windowFocused: true,
	terminalFontSize: 14, terminalLineHeight: 1.25,
	windowFocusListeners: new Set<(focused: boolean) => void>(),
	pullRecords: new Map<string, ArrayBuffer[]>(),
	pullWaiters: new Map<
		string,
		Array<{
			resolve(record: ArrayBuffer): void;
			reject(cause: unknown): void;
		}>
	>(),
	largeViewReturnOptions: undefined as
		| undefined
		| {
				prepare?(generation: string): boolean;
				retired?(generation: string): void;
				conceal(): void;
				reveal(): void;
		  },
};
