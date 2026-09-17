import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, Save, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { FormField } from "@/components/common/FormField";
import { KeyValueList, KeyValueRow } from "@/components/common/KeyValueList";
import { useFeedbackLocale } from "@/components/feedback/useFeedbackLocale";
import { ConfirmationButton } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Disclosure } from "@/components/ui/disclosure";
import { Textarea } from "@/components/ui/textarea";
import {
  crashReportAttachment,
  crashReportBody,
} from "@/lib/feedback/crashReportEnvelope";
import { getOrCreateFeedbackDeviceId } from "@/lib/feedback/deviceId";
import { buildEnvelope, type FeedbackEnvelope } from "@/lib/feedback/envelope";
import { feedbackEnvelopeInput } from "@/lib/feedback/feedbackEnvelopeInput";
import { t } from "@/lib/i18n";
import { saveErrorReportBundle } from "@/lib/ipc";
import {
  FeedbackSubmitError,
  feedbackEnvironment,
  submitFeedback,
} from "@/lib/ipc/feedback";
import { errorMessage } from "@/lib/payloadGuards";
import {
  buildErrorReportBundle,
  currentErrorReportAppMetadata,
  type ErrorIncident,
  serializeErrorReportBundle,
} from "@/lib/platform/errorIncident";

interface ReportStatus {
  kind: "error" | "success";
  message: string;
}

type SendStatus =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; reference: string }
  | { kind: "failed"; error: FeedbackSubmitError };

export function ErrorReportDialog({
  incident,
  open,
  onOpenChange,
}: {
  incident: ErrorIncident;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<ReportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendStatus, setSendStatus] = useState<SendStatus>({ kind: "idle" });
  const [createdAt] = useState(() => new Date().toISOString());
  const app = useMemo(currentErrorReportAppMetadata, []);
  const bundle = useMemo(
    () => buildErrorReportBundle(incident, { notes, createdAt, app }),
    [app, createdAt, incident, notes],
  );
  const preview = useMemo(() => serializeErrorReportBundle(bundle), [bundle]);
  const defaultName = `dure-error-${bundle.incident.fingerprint}-${createdAt.slice(0, 10)}.json`;

  // null until feedbackEnvironment() resolves — sending before then would
  // post os:""/arch:"" (same rationale as FeedbackDialog's identical gate).
  // It always resolves: ipc/feedback.ts falls back to an unknown machine
  // rather than rejecting outside a Tauri webview.
  const [environment, setEnvironment] = useState<{
    os: string;
    arch: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void feedbackEnvironment().then((info) => {
      if (!cancelled) setEnvironment(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const locale = useFeedbackLocale();
  const deviceId = useMemo(() => getOrCreateFeedbackDeviceId(), []);
  const windowSize = useMemo(
    () => ({ width: window.innerWidth, height: window.innerHeight }),
    [],
  );

  // No screenshot: this dialog appears after a failure, there is nothing
  // useful to photograph, and the bundle above is already the evidence
  // (contract point 4). The bundle itself travels as the single attachment;
  // buildEnvelope's `attachment` field carries it, not `screenshot`.
  const envelope = useMemo<FeedbackEnvelope>(
    () =>
      buildEnvelope(
        feedbackEnvelopeInput({
          kind: "crash",
          body: crashReportBody(bundle),
          contact: "",
          deviceId,
          locale,
          window: windowSize,
          os: environment?.os ?? "",
          arch: environment?.arch ?? "",
          includeScreenshot: false,
          attachment: crashReportAttachment(bundle),
          app: bundle.app.frontendBuildId,
          channel: bundle.app.channel,
        }),
      ),
    [bundle, deviceId, locale, windowSize, environment],
  );

  const copyReport = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await writeText(preview);
      setStatus({ kind: "success", message: t("app.errorReport.copied") });
    } catch (error) {
      setStatus({
        kind: "error",
        message: t("app.errorReport.copyFailed", {
          error: errorMessage(error),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  const saveReport = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const path = await save({
        title: t("app.errorReport.saveDialogTitle"),
        defaultPath: defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await saveErrorReportBundle(path, bundle);
      setStatus({ kind: "success", message: t("app.errorReport.saved") });
    } catch (error) {
      setStatus({
        kind: "error",
        message: t("app.errorReport.saveFailed", {
          error: errorMessage(error),
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  const sendReport = async () => {
    if (busy) return;
    setBusy(true);
    setSendStatus({ kind: "sending" });
    try {
      const result = await submitFeedback(envelope);
      setSendStatus({ kind: "sent", reference: result.reference });
    } catch (error) {
      const failure =
        error instanceof FeedbackSubmitError
          ? error
          : new FeedbackSubmitError("network", errorMessage(error));
      setSendStatus({ kind: "failed", error: failure });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(48rem,calc(100vh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("app.errorReport.reviewTitle")}</DialogTitle>
          <DialogDescription>
            {sendStatus.kind === "sent"
              ? t("app.errorReport.sent", { reference: sendStatus.reference })
              : t("app.errorReport.notSentNotice")}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
          <FormField label={t("app.errorReport.notesLabel")}>
            <Textarea
              id="error-report-notes"
              className="min-h-20 text-xs"
              maxLength={4096}
              placeholder={t("app.errorReport.notesPlaceholder")}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </FormField>

          <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">{t("app.errorReport.excludedInfoTitle")}</p>
            <p>
              {t("app.errorReport.excludedInfoBody")}
            </p>
            <p className="mt-1 font-mono">
              {t("app.errorReport.fingerprintLabel")}: {bundle.incident.fingerprint}
            </p>
          </div>

          <pre
            aria-label={t("app.errorReport.jsonPreviewLabel")}
            className="max-h-80 overflow-auto rounded-md border bg-background p-3 font-mono text-[11px] whitespace-pre-wrap break-all"
          >
            {preview}
          </pre>

          {/* What Send adds on top of the bundle above. Read directly off
              `envelope` — the exact object handed to submitFeedback — so
              this can never drift from what actually leaves the machine
              (review finding: the dialog previewed only the bundle while
              Send posted the whole envelope, so kind/env/device/contact
              were never shown even though the notice claimed otherwise). */}
          <Disclosure label={t("app.errorReport.sendDetailsSummary")}>
            <KeyValueList labelWidth="6rem">
              <KeyValueRow label={t("app.errorReport.sendDetailsKind")} mono>
                {envelope.kind}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsNotes")} mono>
                {envelope.body}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsOs")} mono>
                {envelope.env.os}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsArch")} mono>
                {envelope.env.arch}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsLocale")} mono>
                {envelope.env.locale}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsWindow")} mono>
                {envelope.env.window}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsApp")} mono>
                {envelope.env.app}
              </KeyValueRow>
              <KeyValueRow
                label={t("app.errorReport.sendDetailsChannel")}
                mono
              >
                {envelope.env.channel}
              </KeyValueRow>
              <KeyValueRow label={t("app.errorReport.sendDetailsDevice")} mono>
                {envelope.device}
              </KeyValueRow>
              {envelope.contact && (
                <KeyValueRow
                  label={t("app.errorReport.sendDetailsContact")}
                  mono
                >
                  {envelope.contact}
                </KeyValueRow>
              )}
            </KeyValueList>
          </Disclosure>

          {status && (
            <p
              className={
                status.kind === "error"
                  ? "text-xs text-destructive"
                  : "text-xs text-status-run"
              }
              role="status"
            >
              {status.message}
            </p>
          )}

          {sendStatus.kind === "failed" && (
            <p className="text-xs text-destructive" role="status">
              {t("app.errorReport.sendFailed", {
                error: errorMessage(sendStatus.error),
              })}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <ConfirmationButton variant="glass" disabled={busy}>
              {t("common.close")}
            </ConfirmationButton>
          </DialogClose>
          <ConfirmationButton variant="glass" disabled={busy} onClick={() => void copyReport()}>
            <ClipboardCopy className="size-3.5" />
            {t("app.errorReport.copyDiagnostics")}
          </ConfirmationButton>
          <ConfirmationButton disabled={busy} onClick={() => void saveReport()}>
            <Save className="size-3.5" />
            {t("app.errorReport.saveJson")}
          </ConfirmationButton>
          <ConfirmationButton
            variant="glass"
            disabled={busy || environment === null || sendStatus.kind === "sent"}
            onClick={() => void sendReport()}
          >
            <Send className="size-3.5" />
            {sendStatus.kind === "sending"
              ? t("app.errorReport.sending")
              : sendStatus.kind === "sent"
                ? t("app.errorReport.sentButton")
                : sendStatus.kind === "failed"
                  ? t("app.errorReport.retry")
                  : t("app.errorReport.send")}
          </ConfirmationButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
