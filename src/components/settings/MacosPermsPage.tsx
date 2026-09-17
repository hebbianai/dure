/**
 * 설정 → macOS 권한.
 *
 * `SettingsDialog.tsx`에서 빼냈다. 옮긴 이유는 그
 * 파일이 아키텍처 피트니스 래칫의 상한에 붙어 있었고, 모바일 페어링 페이지를
 * 배선할 자리가 없었기 때문이다. AGENTS.md는 자리를 만들려고 baseline을 올리는
 * 것을 금지하고, 대신 건드리는 god-file에서 무언가를 빼내라고 한다.
 *
 * `invoke`를 직접 부르지 않는 것은 여기서 달라진 유일한 점이다. 원래도 규칙
 * 위반이었는데 `SettingsDialog.tsx`가 baseline에 등재돼 있어 게이트가 잡지
 * 못했고, 파일을 빼내는 순간 드러났다.
 *
 * 이후 자동화·로컬 네트워크의 "권한 요청" 버튼이 추가됐다 — 그 둘은 상태를
 * 조회할 API가 없어 배지가 늘 "수동 확인"이라, 실제로 권한을 쓰는 최소 동작을
 * 해서 TCC 프롬프트를 유도하는 것이 유일한 탈출구다.
 */

import { useEffect, useState } from "react";
import { Accessibility, Bluetooth, Camera, ExternalLink, HardDrive, Mic, MonitorUp, Network, RefreshCw, Usb, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageTitle } from "@/components/settings/PageTitle";
import {
  type MacosPermissions,
  macosPermissions,
  openPrivacyPane,
  requestPrivacyPrompt,
} from "@/lib/ipc";
import { t } from "@/lib/i18n";

export function MacosPermsPage() {
  const [perms, setPerms] = useState<MacosPermissions | null>(null);
  /** 프롬프트를 요청 중인 행 — osascript가 응답을 기다리는 동안 중복 클릭을 막는다. */
  const [prompting, setPrompting] = useState<string | null>(null);
  const load = () => {
    macosPermissions()
      .then(setPerms)
      .catch(() => setPerms(null));
  };
  useEffect(load, []);

  const rows: {
    key: string;
    icon: typeof Mic;
    label: string;
    desc: string;
    pane: string;
    status?: boolean | null;
    /** 상태를 조회할 수 없는 권한 — 실제로 써 보게 해서 TCC 프롬프트를 유도한다. */
    prompt?: "automation" | "local_network";
  }[] = [
    { key: "mic", icon: Mic, label: t("settings.macosPerms.microphone.label"), desc: t("settings.macosPerms.microphone.desc"), pane: "Privacy_Microphone", status: perms?.microphone },
    { key: "camera", icon: Camera, label: t("settings.macosPerms.camera.label"), desc: t("settings.macosPerms.camera.desc"), pane: "Privacy_Camera", status: perms?.camera },
    { key: "screen", icon: MonitorUp, label: t("settings.macosPerms.screenRecording.label"), desc: t("settings.macosPerms.screenRecording.desc"), pane: "Privacy_ScreenCapture", status: perms?.screen_recording },
    { key: "ax", icon: Accessibility, label: t("settings.macosPerms.accessibility.label"), desc: t("settings.macosPerms.accessibility.desc"), pane: "Privacy_Accessibility", status: perms?.accessibility },
    { key: "disk", icon: HardDrive, label: t("settings.macosPerms.fullDisk.label"), desc: t("settings.macosPerms.fullDisk.desc"), pane: "Privacy_AllFiles", status: perms?.full_disk },
    { key: "automation", icon: Workflow, label: t("settings.macosPerms.automation.label"), desc: t("settings.macosPerms.automation.desc"), pane: "Privacy_Automation", prompt: "automation" },
    { key: "network", icon: Network, label: t("settings.macosPerms.localNetwork.label"), desc: t("settings.macosPerms.localNetwork.desc"), pane: "Privacy_LocalNetwork", prompt: "local_network" },
    { key: "usb", icon: Usb, label: t("settings.macosPerms.usb.label"), desc: t("settings.macosPerms.usb.desc"), pane: "" },
    { key: "bt", icon: Bluetooth, label: t("settings.macosPerms.bluetooth.label"), desc: t("settings.macosPerms.bluetooth.desc"), pane: "Privacy_Bluetooth", status: perms?.bluetooth },
  ];

  const badge = (v: boolean | null | undefined) =>
    v === true ? (
      <Badge size="sm">{t("settings.permissions.allowed")}</Badge>
    ) : v === false ? (
      <Badge size="sm" variant="secondary">
        {t("settings.permissions.notAllowed")}
      </Badge>
    ) : (
      <Badge size="sm" variant="secondary">
        {t("settings.permissions.manualCheck")}
      </Badge>
    );

  return (
    <>
      <PageTitle
        title={t("settings.macosPerms.title")}
        desc={t("settings.macosPerms.description")}
      />
      {/* 페이지를 감싸던 720px 카드와 목록을 담던 sunken 카드를 걷어냈다(시안
          2525:72518). 남은 상자는 안내 배너 하나뿐이다 — 배너는 목록의 한 항목이
          아니라 목록 전체에 대한 전제라, 테두리가 그 위계 차이를 말한다. */}
      <div className="flex w-full flex-col">
        {/* 안내 배너 + 새로고침 */}
        <Card className="mt-2 flex w-full items-start gap-3 rounded-[11px]">
          <div className="flex min-w-px flex-1 flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground">
              {t("settings.macosPerms.inheritNote")}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("settings.macosPerms.footnote")}
            </span>
          </div>
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={load}>
            <RefreshCw className="size-3" /> {t("common.refresh")}
          </Button>
        </Card>

        <div className="mt-6 h-px w-full bg-border" />

        {/* 권한 목록 — 행 사이 구분선 없이 24px 간격만으로 나눈다. 아홉 줄에
            hairline을 다 그으면 선이 내용보다 많아진다. */}
        {rows.map((r) => (
          <div key={r.key} className="flex w-full items-center gap-3 pt-6 last:pb-6">
            {/* 제목 줄(20px) 첫 글자 높이에 맞춘다 — 두 줄 전체의 가운데가 아니다 */}
            <r.icon className="mt-[3px] size-3.5 shrink-0 self-start text-foreground" />
            <div className="flex min-w-px flex-1 flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">{r.label}</span>
                {badge(r.status)}
              </div>
              <span className="text-xs text-muted-foreground">{r.desc}</span>
            </div>
            {r.prompt && (
              // 자동화·로컬 네트워크는 조회 API가 없어 상태가 늘 "수동 확인"이다.
              // 그 권한을 쓰는 최소 동작을 한 번 해서 macOS가 물어보게 만든다 —
              // 이미 결정된 뒤라면 프롬프트가 안 뜨므로 설정 열기도 함께 둔다.
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                disabled={prompting !== null}
                onClick={() => {
                  setPrompting(r.key);
                  requestPrivacyPrompt(r.prompt as "automation" | "local_network")
                    .catch(() => {})
                    .finally(() => {
                      setPrompting(null);
                      load();
                    });
                }}
              >
                {prompting === r.key ? t("settings.permissions.requesting") : t("settings.permissions.request")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => openPrivacyPane(r.pane).catch(() => {})}
            >
              <ExternalLink className="size-3" /> {t("common.openSettings")}
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
