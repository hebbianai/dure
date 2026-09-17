import { describe, expect, test } from "vitest";
import {
  formatProcessStartMarkerV1,
  formatProcessStartMarkerV1FromUnixSeconds,
  isProcessStartMarkerV1,
  ownedProcessGenerationDigestV1,
  parsePersistedKernelStartMarkerV1,
  persistedKernelStartMarkerV1,
  persistedOwnedProcessV1,
  PROCESS_START_MARKER_V1_PREFIX,
} from "./owned-process-persistence-v1.mjs";

const generations = [
  {
    groupId: 40,
    kernelStartMarker: "kernel-start-v2:linux:boot-a:250",
    parentPid: 7,
    pid: 42,
    sessionId: 40,
    startMarker: "ps-lstart-v1:Tue Nov 14 22:13:22 2023",
  },
  {
    groupId: 7,
    kernelStartMarker:
      "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:9",
    parentPid: 2,
    pid: 7,
    sessionId: 7,
    startMarker: "ps-lstart-v1:Tue Nov 14 22:13:20 2023",
  },
];

describe("owned process persistence v1", () => {
  test("renders and recognizes the byte-compatible UTC start marker", () => {
    const marker = formatProcessStartMarkerV1(
      new Date(Date.UTC(2023, 10, 14, 22, 13, 22, 999)),
    );
    const maximum = `${PROCESS_START_MARKER_V1_PREFIX}${"x".repeat(
      256 - PROCESS_START_MARKER_V1_PREFIX.length,
    )}`;

    expect(marker).toBe("ps-lstart-v1:Tue Nov 14 22:13:22 2023");
    expect(formatProcessStartMarkerV1FromUnixSeconds(1_700_000_002)).toBe(
      marker,
    );
    expect(
      formatProcessStartMarkerV1(new Date(Date.UTC(2023, 10, 4, 2, 3, 4))),
    ).toBe("ps-lstart-v1:Sat Nov 4 02:03:04 2023");
    expect(isProcessStartMarkerV1(marker)).toBe(true);
    expect(isProcessStartMarkerV1(PROCESS_START_MARKER_V1_PREFIX)).toBe(false);
    expect(isProcessStartMarkerV1(maximum)).toBe(true);
    expect(isProcessStartMarkerV1(`${maximum}x`)).toBe(false);
  });

  test("keeps the v1 generation digest stable across input order", () => {
    const expected =
      "ca630acb098821574fde3700852a3db99341564e718d2dd3fb62258fb4e05556";

    expect(ownedProcessGenerationDigestV1([])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(ownedProcessGenerationDigestV1(generations)).toBe(expected);
    expect(ownedProcessGenerationDigestV1([...generations].reverse())).toBe(
      expected,
    );
  });

  test("projects canonical members into legacy persistence without changing identity authority", () => {
    const member = {
      groupId: 42,
      parentPid: 7,
      pid: 42,
      processIdentity: "linux:boot-a:250",
      sessionId: 42,
      startedAtUnixSeconds: 1_700_000_002,
      state: "live",
    };

    expect(persistedKernelStartMarkerV1(member.processIdentity)).toBe(
      "kernel-start-v2:linux:boot-a:250",
    );
    expect(persistedOwnedProcessV1(member)).toEqual({
      groupId: 42,
      kernelStartMarker: "kernel-start-v2:linux:boot-a:250",
      parentPid: 7,
      pid: 42,
      sessionId: 42,
      startMarker: "ps-lstart-v1:Tue Nov 14 22:13:22 2023",
    });
  });

  test("classifies persisted exact and bootless identities once", () => {
    expect(
      parsePersistedKernelStartMarkerV1(
        "kernel-start-v2:linux:boot-a:250",
      ),
    ).toEqual({
      kind: "exact",
      marker: "kernel-start-v2:linux:boot-a:250",
      processIdentity: "linux:boot-a:250",
    });
    expect(
      parsePersistedKernelStartMarkerV1("kernel-start-v1:linux:000250"),
    ).toEqual({
      kind: "linux_bootless",
      marker: "kernel-start-v1:linux:250",
      startTicks: "250",
    });
    expect(
      parsePersistedKernelStartMarkerV1(
        "kernel-start-v3:macos:not-a-uuid:9",
      ),
    ).toBeNull();
  });
});
