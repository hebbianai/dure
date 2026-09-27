import { DockviewReact } from "dockview-react";
import { createRoot } from "react-dom/client";
import { MobileSimulatorPanel } from "@/components/panels/mobile/MobileSimulatorPanel";
import { setLang } from "@/lib/i18n";
import { mobileSimulator } from "@/lib/ipc/mobileSimulator";
import "dockview-react/dist/styles/dockview.css";
import "@/index.css";

setLang("en");
const device = {
	platform: "ios",
	id: "mirroring:42:EKWlAAAAAAA:99",
	transport: "iphone_mirroring",
} as const;
const canvas = document.createElement("canvas");
canvas.width = 390;
canvas.height = 844;
const context = canvas.getContext("2d")!;
context.fillStyle = "#151515";
context.fillRect(0, 0, 390, 844);
context.fillStyle = "#f5f5f5";
context.font = "24px sans-serif";
context.fillText("Fixture phone", 28, 90);
context.font = "16px sans-serif";
context.fillText("Sample content for panel layout", 28, 132);
context.strokeStyle = "#555";
context.strokeRect(28, 178, 334, 52);
context.fillText("A harmless sample button", 46, 210);
mobileSimulator.list = async () => ({
	devices: [
		{
			...device,
			kind: "physical",
			name: "iPhone (iPhone Mirroring)",
			runtime: "iPhone Mirroring",
			state: "ready",
			capabilities: ["capture", "home", "recents"],
		},
	],
	unavailable: [],
});
mobileSimulator.capture = async () => ({
	dataUrl: canvas.toDataURL(),
	width: 390,
	height: 844,
});
mobileSimulator.act = async () => {};
mobileSimulator.liveStart = async () => {
	throw new Error("A physical phone must not use the simulator lease");
};

createRoot(document.getElementById("root")!).render(
	<DockviewReact
		className="dockview-theme-abyss size-full"
		components={{ mobile: MobileSimulatorPanel }}
		onReady={({ api }) => {
			api.addPanel({
				id: "physical-phone",
				component: "mobile",
				title: "iPhone",
				params: { device },
			});
		}}
	/>,
);
