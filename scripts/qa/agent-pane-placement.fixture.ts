import { runAgentPanePlacementFixture } from "@/qa/agentPanePlacement";

runAgentPanePlacementFixture(
	document.getElementById("root")!,
	new URLSearchParams(location.search).get("proof") ?? "visual",
);
