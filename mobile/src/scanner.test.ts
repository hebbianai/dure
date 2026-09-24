import { describe, expect, it } from "vitest";
import { type ScannerBridge, scanPairingCode } from "./scanner";

function bridge(overrides: Partial<ScannerBridge> = {}): ScannerBridge {
  return {
    checkPermissions: async () => "granted",
    requestPermissions: async () => "granted",
    scan: async () => ({ content: "{}" }),
    ...overrides,
  };
}

describe("scanPairingCode", () => {
  it("허가된 카메라에서 읽은 내용을 그대로 돌려준다", async () => {
    const outcome = await scanPairingCode(
      bridge({ scan: async () => ({ content: "hmux-pair:1?a=10.0.0.1&p=1" }) }),
    );

    expect(outcome).toEqual({ kind: "scanned", content: "hmux-pair:1?a=10.0.0.1&p=1" });
  });

  it("QR만 읽도록 요청한다", async () => {
    let requested: string[] = [];
    await scanPairingCode(
      bridge({
        scan: async (options) => {
          requested = options.formats;
          return { content: "{}" };
        },
      }),
    );

    expect(requested).toEqual(["QR_CODE"]);
  });

  /**
   * 데스크탑 빌드의 정상 경로. 크레이트가 통째로 `#![cfg(mobile)]`이라
   * 명령 자체가 없고, 그 거부는 오류 배너가 아니라 붙여넣기 칸으로 이어져야
   * 한다 — 그래야 카메라 없는 환경에서도 페어링을 시험할 수 있다.
   */
  it("플러그인이 없는 플랫폼에서는 실패가 아니라 사용 불가로 답한다", async () => {
    const outcome = await scanPairingCode(
      bridge({
        checkPermissions: async () => {
          throw new Error("plugin barcode-scanner not found");
        },
      }),
    );

    expect(outcome.kind).toBe("unavailable");
  });

  it("권한을 아직 묻지 않았으면 물어본 뒤 스캔한다", async () => {
    let asked = false;
    const outcome = await scanPairingCode(
      bridge({
        checkPermissions: async () => "prompt",
        requestPermissions: async () => {
          asked = true;
          return "granted";
        },
      }),
    );

    expect(asked).toBe(true);
    expect(outcome.kind).toBe("scanned");
  });

  /**
   * 영구 거절은 앱 안에서 되돌릴 수 없다 — 설정 앱으로 보내야 한다. 한 번
   * 거절과 같은 상태로 뭉뚱그리면 사용자는 다시 눌러도 아무 일도 일어나지 않는
   * 버튼을 계속 누르게 된다.
   */
  it("영구 거절과 이번 거절을 구분한다", async () => {
    const blocked = await scanPairingCode(bridge({ checkPermissions: async () => "denied" }));
    const denied = await scanPairingCode(
      bridge({ checkPermissions: async () => "prompt", requestPermissions: async () => "prompt" }),
    );

    expect(blocked.kind).toBe("permission_blocked");
    expect(denied.kind).toBe("permission_denied");
  });

  /** 뒤로 가기는 오류가 아니다. 배너를 띄우면 "취소했는데 왜 오류가 뜨지"가 된다. */
  it("사용자가 취소한 것을 오류로 만들지 않는다", async () => {
    const outcome = await scanPairingCode(
      bridge({
        scan: async () => {
          throw new Error("Scan canceled by user");
        },
      }),
    );

    expect(outcome.kind).toBe("cancelled");
  });

  it.each([
    [{ message: "Camera unavailable", code: "camera_unavailable" }, "Camera unavailable"],
    [{ error: "No capture device" }, "No capture device"],
    [{ code: "unclassified" }, "The camera scanner could not start. Try again or paste a pairing code."],
    [null, "The camera scanner could not start. Try again or paste a pairing code."],
  ])("presents a readable plugin rejection %j", async (error, detail) => {
    expect(await scanPairingCode(bridge({ scan: async () => { throw error; } })))
      .toEqual({ kind: "failed", detail });
  });

  it("recognizes an object-shaped cancellation", async () => {
    expect(await scanPairingCode(bridge({ scan: async () => { throw { message: "Scan cancelled by user" }; } })))
      .toEqual({ kind: "cancelled" });
  });

  it("그 밖의 실패는 이유와 함께 보고한다", async () => {
    const outcome = await scanPairingCode(
      bridge({
        scan: async () => {
          throw new Error("camera busy");
        },
      }),
    );

    expect(outcome).toEqual({ kind: "failed", detail: "camera busy" });
  });
});
