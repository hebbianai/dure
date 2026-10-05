import { createRoot } from "react-dom/client";
import { ProviderCliUpdateFeedback } from "@/components/settings/ProviderCliUpdateFeedback";
import { setLang } from "@/lib/i18n";
import "@/index.css";

setLang("en");
const detail = "Error: Your Command Line Tools are too outdated.\nUpdate them from Software Update in System Settings.\nThe CLI installation has already completed.";
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-3xl space-y-8 p-8 text-foreground">
    <h1 className="text-xl font-semibold">Agent CLI update</h1>
    <section aria-label="Failed update" className="space-y-3">
      <h2 className="font-semibold">Claude Code</h2>
      <ProviderCliUpdateFeedback result={{ kind: "command_failed", exitCode: 1, detail, guidance: "command_line_tools" }} />
    </section>
    <section aria-label="Updated with warning" className="space-y-3">
      <h2 className="font-semibold">Codex</h2>
      <ProviderCliUpdateFeedback result={{ kind: "updated_with_warning", fromVersion: "0.159.0", toVersion: "0.160.0", detail, guidance: "command_line_tools" }} />
    </section>
  </main>,
);
