import { createPreloadableModule } from "@/lib/editor/editorChunkPrefetch";

export const codeEditorModule = createPreloadableModule(
	() => import("@/components/editor/CodeEditor"),
);
