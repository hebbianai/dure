// The pinned band at the top of the Spaces list: pinned panes, then pinned
// repositories. Extracted from SpacesPane when the pane crossed the 900-line
// architecture gate (2026-09-14); the band's reasoning is in the comments it
// brought with it.

import { SidebarGroupLabel } from "@/components/sidebar/SidebarItems";
import type { RepositoryBindings } from "@/components/spaces/SpacesFacetList";
import { SpacesOpenRowList } from "@/components/spaces/SpacesOpenRowList";
import {
  dropKeyInRepository,
  SpacesRepositorySection,
  type SpacesRepositorySectionProps,
} from "@/components/spaces/SpacesRepositorySection";
import type { SpaceRow } from "@/components/spaces/useSpaces";
import { t } from "@/lib/i18n";

export function SpacesPinnedBand({
  pinnedRows,
  pinnedGroups,
  attentionByRepository,
  dropTargetKey,
  emptyLabel,
  repositoryBindings,
}: {
  pinnedRows: readonly SpaceRow[];
  pinnedGroups: readonly SpacesRepositorySectionProps["group"][];
  attentionByRepository: ReadonlyMap<string, number>;
  dropTargetKey: string | null;
  /** What an empty pinned repository says while a search or filter is on. */
  emptyLabel: string | undefined;
  repositoryBindings: RepositoryBindings;
}) {
  return (
    <>
    {/* Pane pins lead repository pins at the top of the list. They used to
        sit above it in a scroll region of their own, capped at 40%, so a
        pin stayed in view however long the list grew — and with one pin
        that region sat on the list like a lid, two scrollers where one
        would do, the list starting mid-panel. A pin is first, not fixed:
        the pinned pane is open anyway and reachable without the sidebar.
        The Files tab made the same move with "Recent file" (owner call
        2026-09-14). */}
    {(pinnedRows.length > 0 || pinnedGroups.length > 0) && (
      <div
        // 16 under the last pinned row: with the row's own 8 inside its
        // card that is 24 before the first repository — what the Files
        // tab leaves between its last recent file and "All files" (8 in
        // the card, 8 under the section, 8 above the label). One group's
        // 20 read too close here, where what follows is a 13px folder
        // row and not a light band (owner report 2026-09-14). No rule —
        // pins are open sessions like everything below them, and a rule
        // marks a change of kind.
        className="pb-4"
        data-spaces-pinned
      >
        {/* The Files tab's own section marker, the same component and the
            same box: 32px tall, the label on the 8px column, 11px medium at
            70% (RecentFileOpensSection). It stood at 16 in a 24px box and
            semibold — the same column its rows' glyphs keep, so the marker
            and what it marks shared a column, and it was a step heavier than
            the identical marker one tab over (owner call 2026-09-14). The
            sidebar's reference tabs decide this.
            mx-2 because the rows carry that inset themselves here, while
            over there both the label and the rows sit inside a scroll
            viewport that holds it — the label has to stand on the same
            column its rows' glyphs do, and without this it hung 8px left of
            them (owner report 2026-09-14).
            mt-2: a section label carries 8px of its own above it, the way
            "Recent file" does in the Files tab, so under the search field's
            8 it stands at 16 in every tab (owner call 2026-09-14). With no
            pins the list viewport's pt-2 puts the first repository row at
            the same 16. */}
        <SidebarGroupLabel className="mx-2 mt-2">
          {t("spaces.pane.pinned")}
        </SidebarGroupLabel>
        {pinnedRows.length > 0 && (
          <div className="@container/space-open-rows mx-2" data-spaces-pinned-panes>
            <SpacesOpenRowList
              {...repositoryBindings}
              spaces={pinnedRows}
              groupBy={undefined}
              spaceHeading={false}
            />
          </div>
        )}
        <div className="mx-2">
          {pinnedGroups.map((group, index) => (
            <SpacesRepositorySection
              key={group.key}
              group={group}
              isFirst={index === 0}
              attentionCount={
                attentionByRepository.get(group.key) ?? 0
              }
              dropTargetKey={
                dropKeyInRepository(dropTargetKey, group.key) ? dropTargetKey : null
              }
              emptyLabel={emptyLabel}
              {...repositoryBindings}
            />
          ))}
        </div>
      </div>
    )}
    </>
  );
}
