import type { CodeEditorProps } from "@/components/editor/CodeEditor";
import { codeEditorModule } from "@/components/editor/codeEditorModule";

/**
 * Suspends only when the idle preload has not finished. Once preloaded, the
 * editor component is returned synchronously so React does not pay the first
 * lazy-boundary reveal delay on the user's pane-open path.
 */
export function LazyCodeEditor(props: CodeEditorProps) {
  const { CodeEditor } = codeEditorModule.read();
  return <CodeEditor {...props} />;
}
