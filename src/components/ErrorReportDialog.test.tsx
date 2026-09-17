// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorIncident } from "@/lib/platform/errorIncident";
import { setLang } from "@/lib/i18n";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  saveErrorReportBundle: vi.fn(),
  writeText: vi.fn(),
  feedbackEnvironment: vi.fn(),
  submitFeedback: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: mocks.writeText,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
}));
vi.mock("@/lib/ipc", () => ({
  saveErrorReportBundle: mocks.saveErrorReportBundle,
}));
vi.mock("@/lib/ipc/feedback", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/ipc/feedback")>(
      "@/lib/ipc/feedback",
    );
  return {
    ...actual,
    feedbackEnvironment: mocks.feedbackEnvironment,
    submitFeedback: mocks.submitFeedback,
  };
});

import { ErrorReportDialog } from "@/components/ErrorReportDialog";
import { FeedbackSubmitError } from "@/lib/ipc/feedback";

const incident = createErrorIncident({
  boundary: "diff-window",
  surface: "diff-window",
  error: Object.assign(new Error("failed at /Users/jay/private/Diff.tsx"), {
    stack:
      "Error: failed\n at Diff (/Users/jay/private/Diff.tsx:42:7)\n token=secret",
  }),
  componentStack: "\n at Diff (/Users/jay/private/Diff.tsx:42:7)",
  occurredAt: "2026-07-29T10:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  setLang("ko");
  mocks.save.mockResolvedValue("/tmp/dure-error.json");
  mocks.saveErrorReportBundle.mockResolvedValue(undefined);
  mocks.writeText.mockResolvedValue(undefined);
  mocks.feedbackEnvironment.mockResolvedValue({
    os: "macOS 14.5",
    arch: "arm64",
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const NOT_SENT_NOTICE =
  "복사와 저장은 아래 JSON 그대로를 사용합니다. 보내기는 그 아래에 나열된 항목도 추가로 전송합니다. 아직 아무것도 전송되지 않았습니다.";

/** Send stays disabled until feedbackEnvironment() resolves — see
 *  FeedbackDialog's identical `environment` gate, reused here for the same
 *  reason (a submission before then would post os:""/arch:""). */
async function waitForSendEnabled() {
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "보내기" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
}

describe("ErrorReportDialog", () => {
  it("previews only redacted fields and performs no implicit I/O", () => {
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );

    const preview = screen.getByLabelText("오류 보고서 JSON 미리보기").textContent ?? "";
    expect(preview).toContain('"surface": "diff-window"');
    expect(preview).toContain("[path]/Diff.tsx");
    expect(preview).toContain("[redacted]");
    expect(preview).not.toContain("/Users/jay");
    expect(preview).not.toContain("token=secret");
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveErrorReportBundle).not.toHaveBeenCalled();
  });

  it("redacts reproduction notes before copying the visible JSON", async () => {
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("재현 방법과 기대한 동작"), {
      target: {
        value: "PATH=/private/bin token=hidden /Users/jay/repo/file.ts",
      },
    });
    const preview = screen.getByLabelText("오류 보고서 JSON 미리보기").textContent ?? "";
    expect(preview).toContain("PATH=[redacted]");
    expect(preview).toContain("[path]/file.ts");
    expect(preview).not.toContain("hidden");

    fireEvent.click(screen.getByRole("button", { name: "진단 복사" }));

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(preview));
    expect(screen.getByRole("status").textContent).toBe(
      "진단 보고서를 복사했습니다.",
    );
  });

  it("saves the exact reviewed bundle only after a destination is selected", async () => {
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "JSON으로 저장" }));

    await waitFor(() =>
      expect(mocks.saveErrorReportBundle).toHaveBeenCalledWith(
        "/tmp/dure-error.json",
        expect.objectContaining({
          schemaVersion: 1,
          kind: "dure.error-report",
          incident: expect.objectContaining({ surface: "diff-window" }),
        }),
      ),
    );
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^dure-error-/),
        filters: [{ name: "JSON", extensions: ["json"] }],
      }),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "진단 보고서를 저장했습니다.",
    );
  });

  it("does not call the export adapter when the save dialog is cancelled", async () => {
    mocks.save.mockResolvedValue(null);
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "JSON으로 저장" }));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.saveErrorReportBundle).not.toHaveBeenCalled();
  });

  it("disables Send until the environment read resolves, so a fast send can never post empty os/arch", async () => {
    let resolveEnvironment: (value: { os: string; arch: string }) => void =
      () => {};
    mocks.feedbackEnvironment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEnvironment = resolve;
        }),
    );
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );

    const sendButton = screen.getByRole("button", {
      name: "보내기",
    }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    resolveEnvironment({ os: "macOS 14.5", arch: "arm64" });
    await waitFor(() => expect(sendButton.disabled).toBe(false));
  });

  it("sends kind:'crash' with the bundle as the single JSON attachment and the notes as the body", async () => {
    mocks.submitFeedback.mockResolvedValue({ reference: "gh-42" });
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    fireEvent.change(screen.getByLabelText("재현 방법과 기대한 동작"), {
      target: { value: "it happened after I saved" },
    });
    const preview = screen.getByLabelText("오류 보고서 JSON 미리보기").textContent ?? "";

    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
    const sent = mocks.submitFeedback.mock.calls[0][0];
    expect(sent.kind).toBe("crash");
    expect(sent.body).toBe("it happened after I saved");
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]).toMatchObject({
      name: "error-report.json",
      media_type: "application/json",
    });
    const attachedJson = new TextDecoder().decode(
      Uint8Array.from(atob(sent.attachments[0].bytes_b64), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(attachedJson).toBe(preview);
  });

  it("shows exactly the envelope fields Send adds beyond the bundle, matching what is actually submitted", async () => {
    mocks.submitFeedback.mockResolvedValue({ reference: "gh-45" });
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    /** Reads a KeyValueRow's value by its label — dt and dd are siblings
     *  inside the row's wrapping div, and the `<details>` is queryable
     *  regardless of its open/closed state (closed only hides it visually,
     *  it never leaves the DOM). */
    function rowValue(label: string): string {
      return screen.getByText(label).nextElementSibling?.textContent ?? "";
    }

    const shown = {
      kind: rowValue("보고서 종류"),
      os: rowValue("OS"),
      arch: rowValue("아키텍처"),
      locale: rowValue("언어"),
      window: rowValue("창 크기"),
      app: rowValue("앱 빌드"),
      channel: rowValue("채널"),
      device: rowValue("사용량 제한 토큰"),
    };
    // ErrorReportDialog never collects a contact, so buildEnvelope omits it
    // and the conditional contact row must not render at all.
    expect(screen.queryByText("연락처")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
    const sent = mocks.submitFeedback.mock.calls[0][0];
    expect(shown).toEqual({
      kind: sent.kind,
      os: sent.env.os,
      arch: sent.env.arch,
      locale: sent.env.locale,
      window: sent.env.window,
      app: sent.env.app,
      channel: sent.env.channel,
      device: sent.device,
    });
    expect(sent.contact).toBeUndefined();
  });

  it("still posts a non-empty body when notes are left empty", async () => {
    mocks.submitFeedback.mockResolvedValue({ reference: "gh-43" });
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
    const sent = mocks.submitFeedback.mock.calls[0][0];
    expect(sent.body.trim().length).toBeGreaterThan(0);
    // The fallback is the (already-redacted) error name and message — the
    // absolute path notes would have leaked is stripped the same way the
    // rest of the bundle is.
    expect(sent.body).toBe(`${incident.error.name}: failed at [path]/Diff.tsx`);
  });

  it("keeps the not-sent notice until a 201 actually comes back, then reports the reference", async () => {
    let resolveSubmit: (value: { reference: string }) => void = () => {};
    mocks.submitFeedback.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    expect(screen.getByText(NOT_SENT_NOTICE)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    // Still "not sent" while the request is in flight — a 201 has not
    // actually come back yet.
    await waitFor(() => expect(mocks.submitFeedback).toHaveBeenCalledTimes(1));
    expect(screen.getByText(NOT_SENT_NOTICE)).toBeTruthy();

    resolveSubmit({ reference: "gh-44" });

    await waitFor(() =>
      expect(screen.queryByText(NOT_SENT_NOTICE)).toBeNull(),
    );
    expect(screen.getByText(/gh-44/)).toBeTruthy();
  });

  // The disclosure exists to be complete about what Send adds, and it
  // listed every envelope field except the one the notes actually become.
  it("names the notes as the report text Send transmits", async () => {
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    fireEvent.change(screen.getByLabelText("재현 방법과 기대한 동작"), {
      target: { value: "clicked save twice" },
    });

    const row = screen.getByText("보고 본문").nextElementSibling;
    expect(row?.textContent).toBe("clicked save twice");
  });

  it("stops offering Send once the report has been accepted", async () => {
    mocks.submitFeedback.mockResolvedValueOnce({ reference: "gh-46" });
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    const sent = await screen.findByRole("button", { name: "전송됨" });
    expect((sent as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sent);
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
  });

  it("keeps the notes and the original notice when the send fails", async () => {
    mocks.submitFeedback.mockRejectedValueOnce(
      new FeedbackSubmitError("network", "feedback request failed: boom"),
    );
    render(
      <ErrorReportDialog incident={incident} open onOpenChange={vi.fn()} />,
    );
    await waitForSendEnabled();

    fireEvent.change(screen.getByLabelText("재현 방법과 기대한 동작"), {
      target: { value: "keep me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    await screen.findByRole("button", { name: "다시 시도" });
    expect(screen.getByText(NOT_SENT_NOTICE)).toBeTruthy();
    expect(
      (
        screen.getByLabelText("재현 방법과 기대한 동작") as HTMLTextAreaElement
      ).value,
    ).toBe("keep me");
  });
});
