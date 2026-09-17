import assert from "node:assert/strict";
import { test } from "vitest";
import { migrationIndex, orderMigrationIssues, readMigrationRecords, renderMigratedIssue } from "./lib/beads-github-migration.mjs";

const issue = { _type: "issue", id: "old-child", title: "Keep the original task", status: "in_progress", priority: 0, issue_type: "bug", assignee: "agent@stable-id", description: "Fix the observed failure", acceptance_criteria: "The original reproduction passes", notes: "Keep this handoff", created_at: "2026-09-06", updated_at: "2026-09-06", dependencies: [{ type: "parent-child", depends_on_id: "old-parent" }] };
const options = { repository: "example/private", archivePath: "docs/operations/archive/source.jsonl.gz", index: new Map([["old-parent", { number: 7, url: "https://github.com/example/private/issues/7" }]]), records: new Map([["old-parent", { status: "open" }]]) };

test("preserves the execution state, acceptance, notes and mapped dependency", () => {
  const rendered = renderMigratedIssue(issue, options);
  assert.equal(rendered.title, issue.title);
  assert.ok(rendered.body.includes(issue.acceptance_criteria));
  assert.ok(rendered.body.includes(issue.notes));
  assert.ok(rendered.body.includes(options.index.get("old-parent").url));
  assert.ok(rendered.labels.includes("status:in-progress"));
  assert.ok(!rendered.body.includes("agent@stable-id"), "migration must not notify a username parsed from source text");
});

test("archives completed work and orders unfinished dependencies first", () => {
  const parent = { ...issue, id: "old-parent", dependencies: [] };
  assert.deepEqual(orderMigrationIssues([issue, { ...issue, id: "done", status: "closed" }, parent]).map((record) => record.id), ["old-parent", "old-child"]);
  assert.throws(() => renderMigratedIssue({ ...issue, status: "closed" }, options));
});

test("resume uses the exact source marker and refuses duplicate destinations", () => {
  const rendered = renderMigratedIssue(issue, options);
  const existing = { number: 9, id: 900, html_url: "https://github.com/example/private/issues/9", body: rendered.body };
  assert.equal(migrationIndex([existing, { number: 1, title: issue.title }]).get(issue.id).number, 9);
  assert.throws(() => migrationIndex([existing, { ...existing, number: 10 }]), /Duplicate destination/u);
});

test("rejects ambiguous exports before publication and retains memory records", () => {
  const memory = { _type: "memory", key: "knowledge", value: "Preserve this context" };
  assert.deepEqual(readMigrationRecords([issue, memory].map(JSON.stringify).join("\n")), [issue, memory]);
  assert.throws(() => readMigrationRecords([issue, issue].map(JSON.stringify).join("\n")), /Duplicate source/u);
  assert.throws(() => readMigrationRecords(JSON.stringify({ ...issue, status: "unknown" })), /Unrecognized status/u);
});

test("oversized records link their intact archive instead of an invalid issue body", () => {
  const source = { ...issue, notes: "Long original handoff. ".repeat(6000) };
  const before = JSON.stringify(source);
  const rendered = renderMigratedIssue(source, options);
  assert.ok([...rendered.body].length < 60_000);
  assert.ok(rendered.body.includes("source archive"));
  assert.equal(JSON.stringify(source), before);
});

test("verifies a newly created issue even while the paginated list is stale", () => {
  const existing = { number: 9, id: 900, html_url: "https://github.com/example/private/issues/9", body: renderMigratedIssue(issue, options).body };
  const reads = [];
  const index = migrationIndex([], {
    receipts: { [issue.id]: { number: 9, id: 900 } },
    lookup(number) { reads.push(number); return existing; },
  });
  assert.equal(index.get(issue.id)?.number, 9);
  assert.deepEqual(reads, [9]);
  assert.throws(() => migrationIndex([], {
    receipts: { [issue.id]: { number: 9, id: 900 } },
    lookup: () => ({ ...existing, id: 901 }),
  }), /identity/u);
});
