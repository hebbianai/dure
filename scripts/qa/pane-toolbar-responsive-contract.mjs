import assert from "node:assert/strict";

export const PANE_TOOLBAR_WIDTHS = Object.freeze([250, 320, 480]);

function overlaps(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function assertVisibleInside(rect, container, label) {
  assert.equal(rect.visible, true, `${label} must remain visible`);
  assert.ok(rect.width > 0 && rect.height > 0, `${label} must have geometry`);
  assert.ok(rect.x >= container.x - 0.5, `${label} escaped the left edge`);
  assert.ok(
    rect.x + rect.width <= container.x + container.width + 0.5,
    `${label} escaped the right edge`,
  );
  assert.ok(rect.y >= container.y - 0.5, `${label} escaped the top edge`);
  assert.ok(
    rect.y + rect.height <= container.y + container.height + 0.5,
    `${label} escaped the bottom edge`,
  );
}

export function assertChatComposerSnapshot(snapshot) {
  assert.deepEqual(snapshot.actions.map((action) => action.name),
    ["Model", "Reasoning effort", "Permissions", "Send"]);
  assert.ok(snapshot.scrollWidth <= snapshot.clientWidth + 1, "chat composer overflowed horizontally");
  for (const action of snapshot.actions) {
    assertVisibleInside(action, snapshot.rect, `chat ${action.name}`);
    assert.equal(action.operable, true, `chat ${action.name} must accept a center click`);
    for (const other of snapshot.actions) {
      if (other !== action) assert.equal(overlaps(action, other), false, "chat actions overlap");
    }
  }
}

/** Machine-readable geometry contract shared by the browser probe and unit tests. */
export function assertPaneToolbarSnapshot(snapshot) {
  assert.ok(
    PANE_TOOLBAR_WIDTHS.includes(snapshot.paneWidth),
    `unsupported pane width ${snapshot.paneWidth}`,
  );
  assert.ok(
    Math.abs(snapshot.paneRect.width - snapshot.paneWidth) <= 1,
    `pane width ${snapshot.paneRect.width} did not settle at ${snapshot.paneWidth}`,
  );
  assert.ok(
    snapshot.toolbar.scrollWidth <= snapshot.toolbar.clientWidth + 1,
    `toolbar overflowed horizontally at ${snapshot.paneWidth}px`,
  );

  assertVisibleInside(snapshot.diff, snapshot.toolbar.rect, "C/W diff summary");
  assertVisibleInside(snapshot.branch, snapshot.toolbar.rect, "branch divergence summary");
  assert.equal(snapshot.diff.text, "C2W3");
  assert.equal(snapshot.branch.text, "↑1↓10");

  assert.deepEqual(snapshot.selectors.map((selector) => selector.name),
    ["Model", "Reasoning effort", "View"], "all launch selectors must be measured");
  for (const selector of snapshot.selectors) {
    assertVisibleInside(selector, snapshot.toolbar.rect, selector.name);
    assert.equal(selector.operable, true, `${selector.name} must accept a center click`);
    if (snapshot.paneWidth <= 320) {
      const center = selector.y + selector.height / 2;
      assert.ok(center >= snapshot.credential.y &&
        center <= snapshot.credential.y + snapshot.credential.height,
      `${selector.name} displaced from the compact toolbar row`);
    }
  }

  const actions = [snapshot.credential, snapshot.diff, snapshot.branch, ...snapshot.selectors];
  for (let index = 0; index < actions.length; index += 1) {
    assertVisibleInside(
      actions[index],
      snapshot.toolbar.rect,
      `toolbar action ${index + 1}`,
    );
    for (let other = index + 1; other < actions.length; other += 1) {
      assert.equal(
        overlaps(actions[index], actions[other]),
        false,
        `toolbar actions ${index + 1} and ${other + 1} overlap`,
      );
    }
  }
}
