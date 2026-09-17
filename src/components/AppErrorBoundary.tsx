import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import { CodeBlock } from "@/components/common/CodeBlock";
import {
  createErrorIncident,
  redactErrorReportText,
  type ErrorIncident,
  type ErrorIncidentBoundary,
  type ErrorReportSurface,
} from "@/lib/platform/errorIncident";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { autoReloadForStaleModule } from "@/lib/platform/staleModuleReload";

interface AppErrorBoundaryState {
  error: Error | null;
  occurredAt?: string;
  componentStack?: string;
}

type ErrorReportDialogComponent = ComponentType<{
  incident: ErrorIncident;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

/** 렌더 트리 오류가 루트 언마운트(빈 화면)로 번지지 않게 막는 경계.
 *
 *  React 18 createRoot는 잡히지 않은 렌더 throw에서 루트 전체를 언마운트한다 —
 *  경계가 없으면 일시적 오류(HMR 스테일 모듈, 청크 로드 실패 등)가 복구 불가한
 *  흰 화면이 된다. 여기서 잡아 같은 자리에서 재시도/새로고침을 제공한다.
 */
export class AppErrorBoundary extends Component<
  {
    children: ReactNode;
    label?:
      | "app"
      | "diff-window"
      | "session-window"
      | "source-control-window"
      | "popout-window";
  },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error) {
    return {
      error,
      occurredAt: new Date().toISOString(),
      componentStack: undefined,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // window.onerror로는 안 잡힌다 — qa.log 관측을 위해 콘솔로 남긴다.
    console.error(`[boundary:${this.props.label ?? "app"}]`, error, info.componentStack);
    // 스테일 번들의 청크 로드 실패는 리로드가 결정적 해법 — 사용자에게
    // Refresh를 누르게 하지 않고 1회 자동 복구한다(쿨다운으로 루프 방지).
    autoReloadForStaleModule(error);
    this.setState({ componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (this.state.error) {
      const boundary = this.props.label ?? "app";
      return (
        <RenderFailure
          boundary={boundary}
          componentStack={this.state.componentStack}
          error={this.state.error}
          occurredAt={this.state.occurredAt}
          surface={boundary === "app" ? "main" : boundary}
          onRetry={() =>
            this.setState({
              error: null,
              occurredAt: undefined,
              componentStack: undefined,
            })
          }
        />
      );
    }
    return this.props.children;
  }
}

/** 경계 폴백 + main.tsx 엔트리 import 실패 공용 화면. */
export function RenderFailure({
  boundary = "entry",
  componentStack,
  error,
  message,
  occurredAt,
  onRetry,
  surface = "main",
}: {
  boundary?: ErrorIncidentBoundary;
  componentStack?: string;
  error?: unknown;
  message?: string;
  occurredAt?: string;
  onRetry?: () => void;
  surface?: ErrorReportSurface;
}) {
  const [reportOpen, setReportOpen] = useState(false);
  const [reportDialog, setReportDialog] =
    useState<ErrorReportDialogComponent | null>(null);
  const [reportLoadError, setReportLoadError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [capturedAt] = useState(() => occurredAt ?? new Date().toISOString());
  const incident = useMemo(
    () =>
      createErrorIncident({
        boundary,
        surface,
        error: error ?? new Error(message || "Unknown render failure"),
        componentStack,
        occurredAt: capturedAt,
      }),
    [boundary, capturedAt, componentStack, error, message, surface],
  );
  const displayMessage = redactErrorReportText(incident.error.message, 4096);
  const openReport = async () => {
    setReportLoadError(null);
    if (reportDialog) {
      setReportOpen(true);
      return;
    }
    setReportLoading(true);
    try {
      const module = await import("@/components/ErrorReportDialog");
      setReportDialog(() => module.ErrorReportDialog);
      setReportOpen(true);
    } catch (loadError) {
      setReportLoadError(
        t("app.renderFailure.reportLoadFailed", {
          error:
            loadError instanceof Error ? loadError.message : String(loadError),
        }),
      );
    } finally {
      setReportLoading(false);
    }
  };
  const ReportDialog = reportDialog;

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
      <div className="flex max-w-md flex-col gap-3 rounded-lg border p-6" role="alert">
        <h1 className="text-sm font-semibold">{t("app.renderFailure.title")}</h1>
        <p className="text-xs text-muted-foreground">
          {t("app.renderFailure.description")}
        </p>
        {displayMessage && (
          <CodeBlock maxHeightClass="max-h-32">{displayMessage}</CodeBlock>
        )}
        <div className="flex gap-2">
          {onRetry && (
            <Button type="button" size="sm" variant="outline" onClick={onRetry}>
              {t("common.retry")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={reportLoading}
            onClick={() => void openReport()}
          >
            {t("app.renderFailure.reportError")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => location.reload()}
          >
            {t("common.refresh")}
          </Button>
        </div>
        {reportLoadError && (
          <p className="text-xs text-destructive" role="status">
            {reportLoadError}
          </p>
        )}
      </div>
      {ReportDialog && (
        <ReportDialog
          incident={incident}
          open={reportOpen}
          onOpenChange={setReportOpen}
        />
      )}
    </div>
  );
}
