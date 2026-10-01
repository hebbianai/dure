import { createRoot } from "react-dom/client";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Disposable browser fixture: production tooltip/input handlers, no app data or runtime.
createRoot(document.getElementById("root")!).render(
	<main style={{ padding: 80, display: "flex", gap: 60, alignItems: "start" }}>
		<button type="button" id="start">Start</button>
		<Tooltip>
			<TooltipTrigger id="hint">Settings</TooltipTrigger>
			<TooltipContent side="bottom">Settings hint</TooltipContent>
		</Tooltip>
		<Tooltip>
			<TooltipTrigger asChild><div id="parent" style={{ padding: 20, border: "1px solid gray" }}>
				<button type="button" id="child">Child control</button>
				<Tooltip>
					<TooltipTrigger id="nested">Nested control</TooltipTrigger>
					<TooltipContent side="bottom">Nested hint</TooltipContent>
				</Tooltip>
			</div></TooltipTrigger>
			<TooltipContent side="bottom">Parent hint</TooltipContent>
		</Tooltip>
		<button type="button" id="outside">Outside</button>
	</main>,
);
