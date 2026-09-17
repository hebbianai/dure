import type { FileTarget } from "@/lib/files/fileTarget";
import { Suspense, useCallback, useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Eye, ExternalLink, FileWarning, Pencil, Save, Undo2 } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { FileContent } from "@/lib/ipc/files";
import { t } from "@/lib/i18n";
import { documentIsDirty, isTextFile, canEditFile } from "@/lib/files/fileDocument";
import { useFileDocument } from "@/components/files/useFileDocument";
import { languageLabel } from "@/lib/editor/codeLang";
import { showToast } from "@/lib/toast";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { LazyCodeEditor } from "@/components/editor/LazyCodeEditor";
import { ImageViewerBody } from "@/components/files/ImageViewerBody";
import { useFileViewerPanelState } from "@/components/files/useFileViewerPanelState";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { RefreshButton } from "@/components/ui/refresh-button";
export type FileViewerParams = FileTarget;

function fmtSize(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

function dataUri(mime: string, b64: string): string {
  return `data:${mime};base64,${b64}`;
}

export function FileViewerPanel(props: IDockviewPanelProps<FileViewerParams>) {
  const { source } = props.params;
  const { autoSaveDelayMs, autoSaveEnabled, minimap } = useFileViewerPanelState();
  const { path: activePath, file, error, candidates, loading, saving, draft, restoredDraft, document } = useFileDocument(props.params, autoSaveEnabled, autoSaveDelayMs);
  const dirty = documentIsDirty({ file, draft });
  const [mdSource, setMdSource] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  useEffect(() => setMdSource(false), [document]);
  useEffect(() => {
    if (restoredDraft && file?.kind === "markdown") setMdSource(true);
  }, [restoredDraft, file?.kind]);
  // pane-open 지연 계측: 마운트 → 파일 로드 + 에디터(lazy CodeMirror) 준비까지.
  const paneId = props.api.id;
  useEffect(() => {
    workspacePerformance.beginPaneOpen(paneId, "file");
  }, [paneId]);
  const handleEditorReady = useCallback(() => {
    workspacePerformance.markPaneReady(paneId);
  }, [paneId]);
  useEffect(() => {
    if (file) applyAutomaticPaneTitle(props.api, dirty ? `● ${file.name}` : file.name);
  }, [file, dirty, props.api]);

  const editable = canEditFile(file);
  const showEditor = editable && (file.kind === "text" || mdSource);
  const body = draft ?? file?.content ?? "";

  return (
    <div className="flex h-full flex-col text-foreground">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        {file && (
          <span className="text-[10px] text-muted-foreground">
            {showEditor ? languageLabel(file.name) : file.kind} · {fmtSize(file.size)}
            {file.truncated && ` · ${t("panels.fileViewer.truncated")}`}
          </span>
        )}
        {source === "ssh" && (
          <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">{t("common.remote")}</span>
        )}
        {file?.truncated && isTextFile(file) && (
          <span className="rounded bg-status-warn/12 px-1 text-[9px] text-foreground">
            {t("panels.fileViewer.tooLargeToEdit")}
          </span>
        )}
        {showEditor && (
          <span className="text-[10px] text-muted-foreground/70">
            {t("{line}:{col}", { line: cursor.line, col: cursor.col })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {dirty && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                title={t("panels.fileViewer.revert")}
                onClick={document.revert}
              >
                <Undo2 />
                {t("panels.fileViewer.revert")}
              </Button>
              <Button
                type="button"
                size="xs"
                title={t("panels.fileViewer.save")}
                onClick={() => void document.save()}
                disabled={saving}
              >
                <Save />
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            </>
          )}
          {file?.kind === "markdown" && editable && (
            <IconButton
              title={mdSource ? t("common.preview") : t("panels.fileViewer.editSource")}
              onClick={() => setMdSource((v) => !v)}
            >
              {mdSource ? <Eye /> : <Pencil />}
            </IconButton>
          )}
          <RefreshButton
            title={dirty ? t("panels.fileViewer.reloadDiscardEdits") : t("common.refresh")}
            aria-label={t("common.refresh")}
            busy={loading}
            onClick={() => void document.load(activePath, true)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {candidates.length > 0 ? (
          <CandidatePicker
            missingPath={activePath}
            candidates={candidates}
            onPick={(picked) => void document.load(picked)}
          />
        ) : error ? (
          <PanelStatus>
            <FileWarning className="size-6" />
            {/* 원문 오류("No such file... (os error 2)")를 그대로 던지지 않는다 —
                터미널에 찍힌 경로를 클릭했을 때 가장 흔한 원인은 그 사이 파일이
                지워진 것이다(QA 산출물은 검증 직후 정리하는 규칙). 사람이 다음
                행동을 고를 수 있는 문장을 먼저 두고, 원문은 근거로 남긴다. */}
            {/No such file|os error 2/i.test(error) ? (
              <p className="max-w-md px-4 text-center">
                {t("panels.fileViewer.fileGone")}
              </p>
            ) : null}
            <p
              className="max-w-md break-all px-4 text-center text-xs opacity-70"
              data-selectable
            >
              {error}
            </p>
          </PanelStatus>
        ) : loading || !file ? (
          <div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>
        ) : showEditor ? (
          <Suspense
            fallback={<div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>}
          >
            <LazyCodeEditor
              value={body}
              fileName={file.name}
              minimap={minimap}
              onChange={document.change}
              onSave={() => void document.save()}
              onCursor={(line, col) => setCursor({ line, col })}
              onReady={handleEditorReady}
            />
          </Suspense>
        ) : (
          <div className="h-full overflow-auto">
            <FileBody paneId={paneId} file={file} local={source === "local"} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 이름만 일치하는 파일이 여러 개일 때 고르게 한다.
 * 후보는 백엔드가 "찾던 경로와 뒤에서부터 몇 구간이 겹치는지"로 정렬해 준다.
 */
function CandidatePicker({
  missingPath,
  candidates,
  onPick,
}: {
  missingPath: string;
  candidates: string[];
  onPick: (path: string) => void;
}) {
  const name = missingPath.split("/").pop() ?? missingPath;
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <p className="text-xs text-muted-foreground">
        {t("panels.fileViewer.pickCandidate", { name })}
      </p>
      <ul className="mt-3 flex flex-col gap-1">
        {candidates.map((c) => (
          <li key={c}>
            <button type="button"
              className="w-full rounded px-2 py-1.5 text-left font-mono text-xs break-all text-foreground/90 hover:bg-accent"
              onClick={() => onPick(c)}
            >
              {c}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 로컬 파일을 OS 기본 앱으로 연다 — 뷰어가 못 여는/잘린 매체의 탈출구. */
function OpenExternallyButton({ path, paneId }: { path: string; paneId?: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => {
        void openPath(path).catch(() =>
          showToast(
            t("common.openFailedPathMissing"),
            paneId ? { paneId } : undefined,
          ),
        );
      }}
    >
      <ExternalLink className="size-3" />
      {t("panels.fileViewer.openInDefaultApp")}
    </button>
  );
}

function FileBody({
  file,
  local,
  paneId,
}: {
  file: FileContent;
  local?: boolean;
  /** The pane showing the file, so its reports land there. */
  paneId?: string;
}) {
  if (file.kind === "markdown") {
    return (
      <div className="prose-terminal mx-auto max-w-3xl px-6 py-5">
        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {file.content}
        </Markdown>
      </div>
    );
  }
  if (file.kind === "image" && file.mime) {
    return (
      <ImageViewerBody src={dataUri(file.mime, file.content)} name={file.name} />
    );
  }
  if (file.kind === "video" && file.mime) {
    // muted는 초기 상태일 뿐 컨트롤로 해제할 수 있다 — 캡션 트랙이 없는 임의
    // 파일 뷰어에서 useMediaCaption 규칙과 양립하는 유일한 정직한 형태.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        {file.truncated ? (
          <p className="text-xs text-muted-foreground">
            {t("panels.fileViewer.mediaPreviewCap")}
          </p>
        ) : null}
        <video
          controls
          muted
          src={dataUri(file.mime, file.content)}
          className="min-h-0 max-w-full flex-1 object-contain"
        />
        {local ? <OpenExternallyButton path={file.path} paneId={paneId} /> : null}
      </div>
    );
  }
  if (file.kind === "pdf" && file.mime) {
    return (
      <object
        data={dataUri(file.mime, file.content)}
        type="application/pdf"
        className="h-full w-full"
      >
        <p className="p-4 text-sm text-muted-foreground">
          {t("panels.fileViewer.pdfNotDisplayable")}
        </p>
      </object>
    );
  }
  if (file.kind === "binary") {
    return (
      <PanelStatus>
        <FileWarning className="size-6" />
        <p>{t("panels.fileViewer.binaryNoPreview", { size: fmtSize(file.size) })}</p>
        {local ? <OpenExternallyButton path={file.path} paneId={paneId} /> : null}
      </PanelStatus>
    );
  }
  // text — 상한(25MB)을 넘겨 잘린 파일만 여기로 온다. 편집을 막고 읽기 전용으로
  // 보여준다 (일부만 저장하면 나머지가 날아간다).
  return (
    <pre className="overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre">
      {file.content}
    </pre>
  );
}
