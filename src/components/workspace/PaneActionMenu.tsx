import { type ReactElement, type ReactNode, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface PaneActionMenuItem {
  id: string;
  label: string;
  detail?: string;
  /**
   * 라벨과 같은 줄, 오른쪽 끝에 서는 흐린 보조 텍스트(시안 2336:37143).
   *
   * `detail`(아랫줄)과 쓰임이 다르다 — 목적지나 소속처럼 라벨을 한 줄로
   * 유지하면서 덧붙일 정보용이다. 한 문장으로 이어 붙이면("숨기기 — Spaces에
   * 유지") 메뉴 폭에서 잘릴 때 뒤쪽 정보가 먼저 사라진다.
   */
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  deferUntilClosed?: boolean;
  onSelect: () => void;
}

/**
 * 서브메뉴 안의 묶음 — 부모 메뉴의 섹션과 같은 규칙이다: 묶음 사이에만
 * 구분선이 서고, 제목이 있으면 첫 항목 위에 흐린 라벨로 선다(시안 472:26116의
 * "SSH").
 *
 * 분할 서브메뉴가 이걸 필요로 한다. 거기서는 "무엇을 열 것인가"가 두 종류로
 * 갈린다 — 이 pane을 그대로 잇는 것(현재와 동일·터미널)과 등록된 SSH 호스트
 * 목록. 뒤쪽은 개수가 사용자마다 다르고 이름도 임의라, 제목 없이 이어 붙이면
 * 앞의 두 항목과 한 덩어리로 읽힌다.
 */
export interface PaneActionMenuGroup {
  id: string;
  label?: string;
  items: PaneActionMenuItem[];
}

interface PaneActionMenuSubmenu {
  id: string;
  label: string;
  icon?: ReactNode;
  groups: PaneActionMenuGroup[];
  /** Management actions outside the scrolling choices, in the same focus scope. */
  footer?: PaneActionMenuGroup;
}

export interface PaneActionMenuSection {
  id: string;
  /**
   * 이 표면에서는 섹션을 그리지 않는다.
   *
   * 두 시안(2332:36522 로컬 pane · 2338:35339 에이전트 pane)의 ⋮ 메뉴에는
   * 분할이 없다. 항목 정의는 탭 우클릭 메뉴와 공유하되 표면별로 빼야 해서,
   * 호출부에서 id로 걸러내는 대신 섹션 자신이 들고 있게 한다.
   */
  hiddenOn?: "dropdown" | "context";
  /**
   * The header draws this section's actions as inline buttons while it is
   * wide enough and folds them away below that; a folded section is carried
   * by the ⋯ menu after all, so a narrow pane still has a visible way to it
   * (owner call 2026-09-13: what the header hides goes to the menu).
   */
  foldedIntoMenu?: boolean;
  items: (PaneActionMenuItem | PaneActionMenuSubmenu)[];
}

function isSubmenu(
  item: PaneActionMenuItem | PaneActionMenuSubmenu,
): item is PaneActionMenuSubmenu {
  return "groups" in item;
}

function useMenuSelection() {
  const deferredAction = useRef<(() => void) | undefined>(undefined);
  function selectItem(item: PaneActionMenuItem) {
    if (item.disabled) return;
    if (item.deferUntilClosed) {
      deferredAction.current = item.onSelect;
    } else {
      item.onSelect();
    }
  }
  function onCloseAutoFocus() {
    const action = deferredAction.current;
    deferredAction.current = undefined;
    // Let the menu finish restoring focus before an action transfers it to
    // a pane input or dialog. A selection-time timer races Radix's teardown.
    if (action) window.queueMicrotask(action);
  }
  return { selectItem, onCloseAutoFocus };
}

function ItemLabel({ item }: { item: PaneActionMenuItem }) {
  return (
    <>
      {item.icon}
      <span className="min-w-0 flex-1 text-xs">
        <span className="block truncate">{item.label}</span>
        {item.detail && (
          <span className="block truncate text-[10px] leading-tight text-muted-foreground">
            {item.detail}
          </span>
        )}
      </span>
      {item.hint && (
        // 힌트는 라벨보다 늦게 줄되, 라벨을 0으로 만들면서까지 버티지는
        // 않는다 — 절반을 넘으면 힌트가 먼저 잘린다. 라벨(에이전트 이름)이
        // 고르는 대상이고 힌트(소속 프로젝트)는 곁다리다.
        <span className="max-w-1/2 shrink-0 truncate text-[11px] font-medium text-muted-foreground">
          {item.hint}
        </span>
      )}
    </>
  );
}

/** 오른쪽 힌트가 붙는 항목은 시안에서 10px 안쪽에 선다(다른 항목은 8px). */
function itemClass(item: PaneActionMenuItem) {
  return item.hint ? "pr-2.5" : undefined;
}

/**
 * Fit short menus to their content while keeping the original 256px ceiling
 * for agent names and project hints. Radix's available width also constrains
 * each surface near the viewport edge; long labels retain their truncation.
 */
const SUBMENU_BASE = "w-max overflow-y-auto";

/**
 * 묶음 제목 글자 크기 — 시안 472:26118의 "SSH"는 11px이다.
 *
 * 메뉴 라벨 토큰의 기본값은 13px이라 항목 라벨과 같은 크기가 된다. 그러면
 * 제목이 고를 수 있는 항목처럼 읽힌다 — 크기로 한 단 내려 위계를 만든다
 * (같은 이유로 항목의 `hint`도 11px이다).
 */
const SUBMENU_GROUP_LABEL_CLASS = "text-[11px]";
const DROPDOWN_SUBMENU_CLASS = `${SUBMENU_BASE} max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] max-w-[min(16rem,var(--radix-dropdown-menu-content-available-width))]`;
const CONTEXT_SUBMENU_CLASS = `${SUBMENU_BASE} max-h-[min(18rem,var(--radix-context-menu-content-available-height))] max-w-[min(16rem,var(--radix-context-menu-content-available-width))]`;

function visibleSections(
  sections: PaneActionMenuSection[],
  surface: "dropdown" | "context",
  headerFolded = false,
) {
  return sections.filter(
    (section) =>
      section.hiddenOn !== surface ||
      (surface === "dropdown" && section.foldedIntoMenu === true && headerFolded),
  );
}

interface MenuItemsProps {
  sections: PaneActionMenuSection[];
  selectItem: (item: PaneActionMenuItem) => void;
  /** The header has folded its inline action buttons (see foldedIntoMenu). */
  headerFolded?: boolean;
}

function SubmenuContent({
  item,
  surface,
  selectItem,
}: {
  item: PaneActionMenuSubmenu;
  surface: "dropdown" | "context";
  selectItem: MenuItemsProps["selectItem"];
}) {
  const context = surface === "context";
  const Content = context ? ContextMenuSubContent : DropdownMenuSubContent;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  const Label = context ? ContextMenuLabel : DropdownMenuLabel;
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const renderGroup = (group: PaneActionMenuGroup, index: number) => (
    <div key={group.id} role="presentation">
      {index > 0 && <Separator />}
      {group.label && (
        <Label className={SUBMENU_GROUP_LABEL_CLASS}>{group.label}</Label>
      )}
      {group.items.map((child) => (
        <Item
          key={child.id}
          className={itemClass(child)}
          disabled={child.disabled}
          variant={child.destructive ? "destructive" : "default"}
          onSelect={() => selectItem(child)}
        >
          <ItemLabel item={child} />
        </Item>
      ))}
    </div>
  );
  const groups = item.groups.map(renderGroup);
  return (
    <Content
      className={cn(
        context ? CONTEXT_SUBMENU_CLASS : DROPDOWN_SUBMENU_CLASS,
        item.footer && "flex flex-col overflow-hidden",
      )}
    >
      {item.footer ? (
        <>
          <div className="min-h-0 overflow-y-auto [scrollbar-width:thin]">
            {groups}
          </div>
          <div className="shrink-0">
            {renderGroup(item.footer, item.groups.length)}
          </div>
        </>
      ) : (
        groups
      )}
    </Content>
  );
}

function DropdownItems({ sections, selectItem, headerFolded }: MenuItemsProps) {
  return visibleSections(sections, "dropdown", headerFolded).map((section, sectionIndex) => (
    <div key={section.id} role="presentation">
      {sectionIndex > 0 && <DropdownMenuSeparator />}
      {section.items.map((item) =>
        isSubmenu(item) ? (
          <DropdownMenuSub key={item.id}>
            <DropdownMenuSubTrigger>
              {item.icon}
              <span className="text-xs">{item.label}</span>
            </DropdownMenuSubTrigger>
            <SubmenuContent
              item={item}
              surface="dropdown"
              selectItem={selectItem}
            />
          </DropdownMenuSub>
        ) : (
          <DropdownMenuItem
            key={item.id}
            className={itemClass(item)}
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            onSelect={() => selectItem(item)}
          >
            <ItemLabel item={item} />
          </DropdownMenuItem>
        ),
      )}
    </div>
  ));
}

function ContextItems({ sections, selectItem }: MenuItemsProps) {
  return visibleSections(sections, "context").map((section, sectionIndex) => (
    <div key={section.id} role="presentation">
      {sectionIndex > 0 && <ContextMenuSeparator />}
      {section.items.map((item) =>
        isSubmenu(item) ? (
          <ContextMenuSub key={item.id}>
            <ContextMenuSubTrigger>
              {item.icon}
              <span className="text-xs">{item.label}</span>
            </ContextMenuSubTrigger>
            <SubmenuContent
              item={item}
              surface="context"
              selectItem={selectItem}
            />
          </ContextMenuSub>
        ) : (
          <ContextMenuItem
            key={item.id}
            className={itemClass(item)}
            disabled={item.disabled}
            variant={item.destructive ? "destructive" : "default"}
            onSelect={() => selectItem(item)}
          >
            <ItemLabel item={item} />
          </ContextMenuItem>
        ),
      )}
    </div>
  ));
}

export function PaneActionDropdown({
  open,
  onOpenChange,
  trigger,
  sections,
  headerFolded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactElement;
  sections: PaneActionMenuSection[];
  /** See PaneActionMenuSection.foldedIntoMenu. */
  headerFolded?: boolean;
}) {
  const { selectItem, onCloseAutoFocus } = useMenuSelection();
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        className="w-56"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownItems
          sections={sections}
          selectItem={selectItem}
          headerFolded={headerFolded}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PaneActionContextMenu({
  children,
  open,
  onOpenChange,
  sections,
}: {
  children: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  sections: PaneActionMenuSection[];
}) {
  const { selectItem, onCloseAutoFocus } = useMenuSelection();
  return (
    <ContextMenu open={open} onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56" onCloseAutoFocus={onCloseAutoFocus}>
        <ContextItems sections={sections} selectItem={selectItem} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
