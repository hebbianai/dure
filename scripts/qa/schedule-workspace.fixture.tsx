import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AutomationFlow, type AutomationStep } from "@/components/automations/AutomationFlow";
import { newScheduleDraft } from "@/lib/automations/scheduleContract";
import { setLang } from "@/lib/i18n";
import "@/index.css";

setLang("en");
const baselinePath = "/output/playwright/schedule-workspace/AutomationFlow.before.tsx";
const Flow = new URLSearchParams(location.search).has("before")
  ? (await import(/* @vite-ignore */ baselinePath)).AutomationFlow as typeof AutomationFlow
  : AutomationFlow;
function Fixture() {
  const [draft, setDraft] = useState(() => ({ ...newScheduleDraft(), name: "Daily operations" }));
  const [step, setStep] = useState<AutomationStep>("agent");
  return <main className="mx-auto h-screen max-w-5xl overflow-y-auto p-6 text-foreground">
    <h1 className="mb-4 text-lg font-semibold">Daily operations</h1>
    <Flow draft={draft} setDraft={setDraft} step={step} setStep={setStep} disabled={false} projects={[{ id: "operations", displayName: "Operations folder" }]} />
    <output aria-label="Saved workspace policy">{draft.runTemplate.worktree?.kind ?? "dedicated"}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
