// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";
// This suite verifies boundary wiring; ErrorReportDialog has its own tests.
// Preload its lazy chunk so runner load cannot become part of this assertion.
import "./ErrorReportDialog";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("boom: render failed");
  return <div>정상 콘텐츠</div>;
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    // React가 경계 잡힌 오류도 콘솔에 찍는다 — 테스트 출력 오염 방지.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("정상 렌더에서는 자식을 그대로 보여준다", () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow={false} />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("정상 콘텐츠")).toBeTruthy();
  });

  it("자식이 throw하면 언마운트 대신 폴백을 보여준다", () => {
    render(
      <AppErrorBoundary>
        <Bomb shouldThrow={true} />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/boom: render failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "오류 보고" })).toBeTruthy();
  });

  it("별도 diff 창의 보고서에 정확한 surface를 표시한다", async () => {
    render(
      <AppErrorBoundary label="diff-window">
        <Bomb shouldThrow />
      </AppErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "오류 보고" }));

    expect(
      (await screen.findByLabelText("오류 보고서 JSON 미리보기")).textContent,
    ).toContain('"surface": "diff-window"');
  });

  it("별도 세션 창의 보고서에 정확한 surface를 표시한다", async () => {
    render(
      <AppErrorBoundary label="session-window">
        <Bomb shouldThrow />
      </AppErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "오류 보고" }));

    expect(
      (await screen.findByLabelText("오류 보고서 JSON 미리보기")).textContent,
    ).toContain('"surface": "session-window"');
  });

  it("'다시 시도'는 경계를 리셋해 자식을 다시 렌더한다", () => {
    function Harness() {
      const [armed, setArmed] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setArmed(false)}>
            해제
          </button>
          <AppErrorBoundary>
            <Bomb shouldThrow={armed} />
          </AppErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    // 오류 상태 — 원인 제거 후 재시도하면 정상 콘텐츠로 복귀해야 한다.
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("정상 콘텐츠")).toBeNull();
    fireEvent.click(screen.getByText("해제"));
    fireEvent.click(screen.getByText("다시 시도"));
    expect(screen.getByText("정상 콘텐츠")).toBeTruthy();
  });
});
