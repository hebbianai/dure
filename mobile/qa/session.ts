import "../src/styles.css";
import { renderSessionScreen, type SessionPanel } from "../src/sessionScreen";
import { projectHome } from "../src/homeProjection";
import { loadHomeViewOptions } from "../src/homeViewPreferences";
import { TERMINAL_KEYS } from "../src/terminalKeys";
import type { AttachedSession } from "../src/ipc";
import { createTerminalPaste } from "../src/terminalPaste";
import { createHomeFixture } from "./homeFixture";
import { mountStructuredTerminal } from "../src/structuredTerminal";
import { viewportFrameRecord } from "@/test/terminalRecordFixtures";
import { RowTermination } from "@/contracts/terminalStateProtocol";
import { publishTranscriptLift } from "../src/transcriptLift";

const model = createHomeFixture();
const options = loadHomeViewOptions();
const groups = projectHome(model, options, Date.now()).groups;
const root = document.getElementById("session-qa")!;
const transcript = document.createElement("div");
transcript.className = "session__terminal";
transcript.style.padding = "16px";
// Exercise the production renderer, gestures and copy path with synthetic frames.
let revision = 0n;
let deliver: ((record: ArrayBuffer) => void) | undefined;
let pending: ArrayBuffer | undefined;
const surface = mountStructuredTerminal(
	transcript,
	{
		attachment_id: "session-qa",
		terminal_epoch: "session-qa",
		through_output_seq: "1",
		state_revision: "1",
		initial_delivery_record_count: 1,
	},
	{
		next: () =>
			new Promise((resolve) => {
				if (pending) {
					const record = pending;
					pending = undefined;
					resolve(record);
				} else deliver = resolve;
			}),
		send: async () => {},
	},
);
let prompt = "";
let panel: SessionPanel = new URLSearchParams(location.search).has("paste")
	? "none"
	: "sessions";
let session = model.hubs[0].sessions[0];
const paint = () => {
	const text = `Keyboard QA — synthetic terminal\n\n❯ ${prompt}\n        clipboard target\n${transcript.dataset.notice ?? ""}`;
	const texts: string[] = [];
	const logicalLineIds: bigint[] = [];
	const rowTerminations: RowTermination[] = [];
	text.split("\n").forEach((line, index) => {
		const characters = Array.from(line);
		for (let start = 0; start < Math.max(1, characters.length); start += 42) {
			// Hmux's live viewport includes blank cells through the row's width.
			texts.push(
				characters
					.slice(start, start + 42)
					.join("")
					.padEnd(42),
			);
			logicalLineIds.push(BigInt(index + 1));
			rowTerminations.push(
				start + 42 < characters.length
					? RowTermination.SOFT_WRAP
					: RowTermination.HARD_BREAK,
			);
		}
	});
	const record = viewportFrameRecord({
		terminalEpoch: "session-qa",
		projectionRevision: ++revision,
		columns: 42,
		texts,
		logicalLineIds,
		rowTerminations,
	}).buffer as ArrayBuffer;
	if (deliver) {
		const accept = deliver;
		deliver = undefined;
		accept(record);
	} else pending = record;
	transcript.dataset.prompt = prompt;
};
function draw() {
	root.replaceChildren(
		renderSessionScreen(
			{
				machineLabel: "QA Mac",
				trail: ["Dure", "QA"],
				session,
				attached: { role: "controller" } as AttachedSession,
				panel,
				tray: TERMINAL_KEYS.filter((key) =>
					["shift-tab", "?", "/", "esc", "tab", "ctrl"].includes(key.id),
				),
				history: [],
				siblings: groups,
				viewOptions: options,
				nowMs: Date.now(),
				haptics: false,
			},
			{
				back: () => {
					location.href = "/home.html";
				},
				transcript: () => transcript,
				enableInput: () => {},
				press: (key) => {
					transcript.dataset.lastKey = key;
				},
				type: (text) => {
					prompt += text;
					paint();
				},
				paste: createTerminalPaste({
					active: () => root.isConnected,
					send: (text) => {
						prompt += text;
						paint();
					},
					stageImage: async (file) => {
						transcript.dataset.image = file.dataB64;
						transcript.dataset.imageName = file.fileName;
						return ["/tmp/clipboard-qa/pasted-image.png"];
					},
					notice: (text) => {
						transcript.dataset.notice = text;
						paint();
					},
				}),
				nativeKey: (event) => {
					if (event.key === "Backspace")
						prompt = [...prompt].slice(0, -1).join("");
					if (event.key === "Enter") prompt = "";
					paint();
				},
				draft: () => prompt,
				submit: () => {
					prompt = "";
					paint();
				},
				togglePanel: (next) => {
					panel = panel === next ? "none" : next;
					draw();
				},
				runCommand: () => {},
				openSession: (row) => {
					session = model.hubs[0].sessions.find(
						(candidate) => candidate.session_id === row.sessionId,
					)!;
					draw();
				},
				openSourceControl: () => {},
			},
		),
	);
	paint();
}
draw();

// Match the app's keyboard layout in native WebView QA, including the input pad.
document.documentElement.dataset.screen = "session";
const refit = () => {
	const viewport = window.visualViewport;
	if (!viewport) return;
	const root = document.documentElement;
	root.style.setProperty(
		"--app-viewport-height",
		`${Math.round(viewport.height)}px`,
	);
	root.style.setProperty(
		"--app-viewport-top",
		`${Math.round(viewport.offsetTop)}px`,
	);
	const covered =
		viewport.scale <= 1.01 && innerHeight - viewport.height > 120
			? innerHeight - viewport.height
			: 0;
	if (covered) root.dataset.keyboard = "on";
	else delete root.dataset.keyboard;
	publishTranscriptLift(root, {
		tray: document.querySelector(".tray"),
		drawer: document.querySelector(".tray__panel"),
		stage: document.querySelector(".session__stage"),
		covered,
	});
	surface.fit();
};
refit();
window.visualViewport?.addEventListener("resize", refit);
window.visualViewport?.addEventListener("scroll", refit);
const dispose = () => {
	surface.dispose();
	window.visualViewport?.removeEventListener("resize", refit);
	window.visualViewport?.removeEventListener("scroll", refit);
};
window.addEventListener("pagehide", dispose, { once: true });
import.meta.hot?.dispose(dispose);
