// 설정 > 외관의 컬러 스킴 갤러리 — 다크/라이트 슬롯별로 appearance가 맞는
// 스킴 카드를 나열한다. 선택은 uiPrefs.themeScheme(persist)으로 저장되고,
// 적용은 useRootDarkClass(스타일 주입)·터미널·에디터가 이미 따라간다.
import { useState } from "react";
import { open as openFileDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import { fileSizeBytes, readTextFile } from "@/lib/agents/providerConfig";
import {
  DARK_TERMINAL_PALETTE,
  LIGHT_TERMINAL_PALETTE,
  type TerminalPalette,
} from "@/lib/theme/terminalTheme";
import { BUNDLED_THEMES } from "@/lib/theme/bundledThemes";
import { parseThemeDefinition, ThemeIdCollisionError } from "@/lib/theme/themeDefinition";
import { BUILTIN_THEMES, canonicalThemeId } from "@/lib/theme/themeRegistry";
import {
  defaultSchemeDisclosure,
  type SchemeDisclosure,
  type SchemeMode,
} from "@/lib/theme/themeSchemeDisclosure";
import { cn } from "@/lib/utils";
import {
  addCustomThemeToStore,
  useSchemeSlotState,
  useThemeSchemePickerState,
} from "@/components/settings/useThemeSchemePickerState";

const ANSI_DOTS: (keyof TerminalPalette)[] = ["red", "yellow", "green", "cyan", "blue", "magenta"];
// 유저 JSON을 그대로 신뢰하지 않는다 — 파싱 전에 바이트 수부터 자른다
// (codex 설계 검토 E "크기 제한"). 20슬롯+오버라이드를 가진 정상 테마
// 파일은 몇 KB 안쪽이라 64KB면 여유롭다.
const MAX_THEME_FILE_BYTES = 64 * 1024;

/** 스킴 색만으로 그린 미니 터미널 타일. 카드용(70×32)과 접힌 헤더의
 *  인라인 요약용(56×26) 두 크기를 쓴다. 타일 배경은 앱 모드가 아니라 스킴
 *  색이므로, 헤어라인도 그 스킴의 전경에서 뽑아야 어두운 스킴에서 사라지지
 *  않는다. */
function SchemePreview({ palette, inline = false }: { palette: TerminalPalette; inline?: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 flex-col justify-center rounded-md",
        inline ? "h-[26px] w-14 gap-1 px-1.5" : "h-8 w-[70px] gap-[5px] px-[7px]",
      )}
      style={{
        backgroundColor: palette.background,
        boxShadow: `inset 0 0 0 1px ${palette.foreground}2e`,
      }}
      aria-hidden="true"
    >
      <span
        className={cn("font-mono leading-none", inline ? "text-[8px]" : "text-[9px]")}
        style={{ color: palette.foreground }}
      >
        Aa
      </span>
      <span className={cn("flex", inline ? "gap-[2.5px]" : "gap-[3px]")}>
        {ANSI_DOTS.map((slot) => (
          <span
            key={slot}
            className={cn("rounded-full", inline ? "size-[3.5px]" : "size-1")}
            style={{ backgroundColor: palette[slot] }}
          />
        ))}
      </span>
    </span>
  );
}

function SchemeCard({
  name,
  palette,
  selected,
  onSelect,
  onRemove,
}: {
  name: string;
  palette: TerminalPalette;
  selected: boolean;
  onSelect: () => void;
  /** 커스텀 스킴만 제공 — 있으면 카드 끝에 제거 버튼이 뜬다 */
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-[46px] min-w-0 items-center gap-2 rounded-lg border py-2 pr-2.5 pl-2 transition-colors",
        selected ? "border-ring" : "border-border hover:border-muted-foreground/50",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <SchemePreview palette={palette} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-none text-foreground">
          {name}
        </span>
      </button>
      {selected && <Check className="size-3 shrink-0 text-foreground" />}
      {onRemove && (
        <IconButton
          onClick={onRemove}
          title={t("settings.appearance.scheme.removeCustom")}
          className="shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
        >
          <X />
        </IconButton>
      )}
    </div>
  );
}

interface SchemeOption {
  key: string;
  name: string;
  palette: TerminalPalette;
  selected: boolean;
  onSelect: () => void;
  /** 커스텀 스킴만 — 내장·번들은 지울 수 없다 */
  onRemove?: () => void;
}

function SchemeSlot({
  mode,
  open,
  onToggle,
}: {
  mode: SchemeMode;
  open: boolean;
  onToggle: () => void;
}) {
  const { selectedId, customThemes, removeCustomTheme, pick } =
    useSchemeSlotState(mode);
  const canonicalSelectedId = canonicalThemeId(selectedId);
  // 내장(dure-*)은 "기본" 카드가 대신한다 — 미선택(undefined)과 사실상
  // 같은 룩이라 목록에 두 번 보이면 혼란만 준다. persist에 내장 id가 손으로
  // 적혀 있으면 기본 카드가 선택으로 보이는데(주입은 내장 근사 스타일),
  // UI로는 만들 수 없는 상태고 기본 카드 클릭 한 번으로 정리된다.
  const builtinIds = new Set(BUILTIN_THEMES.map((theme) => theme.id));
  const bundled = BUNDLED_THEMES.filter((theme) => theme.appearance === mode);
  const custom = customThemes.filter((theme) => theme.appearance === mode);
  const knownSelection =
    canonicalSelectedId &&
    (bundled.some((theme) => theme.id === canonicalSelectedId) ||
      custom.some((theme) => theme.id === canonicalSelectedId));
  // 내장(dure-*) id는 UI로 쓸 수 없는 값이라 손으로 건드린 persist에서만
  // 나온다. 조용히 기본 카드가 선택된 것처럼 보이면 실제 주입(내장 근사
  // 스타일)과 어긋나므로, 구분되는 카드로 드러내 정리를 유도한다.
  const isLegacyBuiltinSelection = builtinIds.has(canonicalSelectedId ?? "");
  const defaultSelected = !knownSelection && !isLegacyBuiltinSelection;
  const defaultPalette = mode === "dark" ? DARK_TERMINAL_PALETTE : LIGHT_TERMINAL_PALETTE;

  // 카드 목록을 먼저 만들어 둔다 — 접혔을 때 헤더에 보여줄 "지금 선택된 것"이
  // 그리는 목록과 같은 판정에서 나와야 둘이 어긋나지 않는다.
  const options: SchemeOption[] = [
    {
      key: "__default",
      name: t("common.default"),
      palette: defaultPalette,
      selected: defaultSelected,
      onSelect: () => pick(undefined),
    },
    ...(isLegacyBuiltinSelection
      ? [
          {
            key: "__legacy",
            name: t("settings.appearance.scheme.legacySelection"),
            palette: defaultPalette,
            selected: true,
            onSelect: () => pick(undefined),
          },
        ]
      : []),
    ...bundled.map((theme) => ({
      key: theme.id,
      name: theme.name,
      palette: theme.terminal,
      selected: canonicalSelectedId === theme.id,
      onSelect: () => pick(theme.id),
    })),
    ...custom.map((theme) => ({
      key: theme.id,
      name: theme.name,
      palette: theme.terminal,
      selected: canonicalSelectedId === theme.id,
      onSelect: () => pick(theme.id),
      onRemove: () => removeCustomTheme(theme.id),
    })),
  ];
  const current = options.find((option) => option.selected) ?? options[0];

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 pr-3.5 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-sm font-medium leading-none text-foreground">
            {mode === "dark" ? t("settings.appearance.scheme.title") : t("settings.appearance.scheme.lightTitle")}
          </span>
          <span className="text-xs leading-4 text-muted-foreground">
            {open
              ? mode === "dark"
                ? t("settings.appearance.scheme.darkDesc")
                : t("settings.appearance.scheme.lightDesc")
              : mode === "dark"
                ? t("settings.appearance.scheme.darkCollapsedHint")
                : t("settings.appearance.scheme.lightCollapsedHint")}
          </span>
        </span>
        {/* 접었을 때만 지금 고른 스킴을 요약해 보여준다 — 펼치면 카드가 이미
            같은 정보를 더 크게 들고 있어 중복이다. */}
        {!open && (
          <>
            <SchemePreview palette={current.palette} inline />
            <span className="max-w-[120px] truncate text-xs text-foreground">{current.name}</span>
          </>
        )}
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="grid grid-cols-3 gap-2.5">
          {options.map((option) => (
            <SchemeCard
              key={option.key}
              name={option.name}
              palette={option.palette}
              selected={option.selected}
              onSelect={option.onSelect}
              onRemove={option.onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 파일 하나를 골라 검증 후 store에 추가. 실패 사유는 그대로 대화상자에
 *  보여준다 — parseThemeDefinition의 에러 문자열이 이미 t()로 번역돼 있다. */
async function importCustomTheme() {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: t("settings.appearance.scheme.import.filePickerTitle"),
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (typeof picked !== "string") return;

  // 전체를 읽기 전에 크기부터 확인한다 — 잘못 고른 대용량 파일이 IPC로
  // 통째로 넘어오는 것을 막는다(codex 설계 검토 E "크기 제한").
  const size = await fileSizeBytes(picked);
  if (size === 0 || size > MAX_THEME_FILE_BYTES) {
    await messageDialog(
      size === 0
        ? t("settings.appearance.scheme.import.readFailedCheckPath")
        : t("settings.appearance.scheme.import.tooLarge"),
      { title: t("settings.appearance.scheme.import.failedTitle"), kind: "error" },
    );
    return;
  }

  let text: string;
  try {
    text = await readTextFile(picked);
  } catch (error) {
    await messageDialog(String(error), { title: t("settings.appearance.scheme.import.readFailed"), kind: "error" });
    return;
  }
  if (!text) {
    await messageDialog(t("settings.appearance.scheme.import.readFailedCheckPath"), {
      title: t("settings.appearance.scheme.import.failedTitle"),
      kind: "error",
    });
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    await messageDialog(t("settings.appearance.scheme.import.parseFailed"), { title: t("settings.appearance.scheme.import.failedTitle"), kind: "error" });
    return;
  }
  const parsed = parseThemeDefinition(json);
  if (!parsed.theme) {
    await messageDialog(parsed.error, { title: t("settings.appearance.scheme.import.failedTitle"), kind: "error" });
    return;
  }
  try {
    addCustomThemeToStore(parsed.theme);
  } catch (error) {
    if (error instanceof ThemeIdCollisionError) {
      await messageDialog(
        t("settings.appearance.scheme.import.duplicateId", { id: error.id }),
        { title: t("settings.appearance.scheme.import.failedTitle"), kind: "error" },
      );
      return;
    }
    throw error;
  }
}

/** 다크/라이트 두 슬롯의 스킴 갤러리 + 커스텀 JSON 가져오기 (설정 > 외관). */
export function ThemeSchemePicker() {
  const [importing, setImporting] = useState(false);
  const { theme } = useThemeSchemePickerState();
  // 펼침은 테마에서 파생하되 손으로 접었다 펼 수 있다. 어느 테마에서 만든
  // 상태인지 함께 들고 있다가 테마가 바뀌면 파생값으로 되돌린다 — 라이트로
  // 바꿨는데 다크만 펼쳐진 채로 남는 것이 제일 나쁘다.
  const [override, setOverride] = useState<{
    theme: typeof theme;
    open: SchemeDisclosure;
  } | null>(null);
  const open = override?.theme === theme ? override.open : defaultSchemeDisclosure(theme);
  const toggle = (mode: SchemeMode) =>
    setOverride({ theme, open: { ...open, [mode]: !open[mode] } });
  return (
    <div className="flex flex-col gap-5">
      <SchemeSlot mode="dark" open={open.dark} onToggle={() => toggle("dark")} />
      <SchemeSlot mode="light" open={open.light} onToggle={() => toggle("light")} />
      <div className="flex items-center justify-between">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-fit"
          disabled={importing}
          onClick={() => {
            setImporting(true);
            importCustomTheme().finally(() => setImporting(false));
          }}
        >
          {importing ? t("settings.appearance.scheme.import.importing") : t("settings.appearance.scheme.import.action")}
        </Button>
        <span className="text-meta text-muted-foreground">
          {t("settings.appearance.scheme.bundledCredit", {
            n: BUNDLED_THEMES.length,
          })}
        </span>
      </div>
    </div>
  );
}
