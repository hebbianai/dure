import crypto from "node:crypto";

export const MIGRATION_MARKER = /<!-- dure-beads-migration:v1 ([A-Za-z0-9][A-Za-z0-9._-]*) -->/u;

export function readMigrationRecords(source) {
  const records = source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const seen = new Set();
  for (const record of records) {
    if (record._type === "memory") continue;
    if (record._type !== "issue" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(record.id ?? "")) {
      throw new Error("Unrecognized Beads export record");
    }
    if (seen.has(record.id)) throw new Error(`Duplicate source issue: ${record.id}`);
    if (!["open", "in_progress", "blocked", "deferred", "closed"].includes(record.status)) {
      throw new Error(`Unrecognized status for ${record.id}`);
    }
    seen.add(record.id);
  }
  return records;
}

export function migrationIndex(issues, { receipts = {}, lookup } = {}) {
  const index = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const id = MIGRATION_MARKER.exec(issue.body ?? "")?.[1];
    if (!id) continue;
    if (index.has(id)) throw new Error(`Duplicate destination issue: ${id}`);
    index.set(id, { number: issue.number, url: issue.html_url, id: issue.id });
  }
  // Pagination can lag a successful create. Its receipt pins the immutable
  // issue identity, so confirm a missing row at the exact resource before
  // declaring it lost. Never replay a create to repair a listing omission.
  for (const [id, receipt] of Object.entries(receipts)) {
    let observed = index.get(id);
    if (!observed) {
      const exact = lookup?.(receipt.number);
      if (!exact || exact.pull_request || MIGRATION_MARKER.exec(exact.body ?? "")?.[1] !== id) {
        throw new Error(`Recorded destination identity is missing: ${id}`);
      }
      observed = { number: exact.number, url: exact.html_url, id: exact.id };
    }
    if (observed.number !== receipt.number || observed.id !== receipt.id) {
      throw new Error(`Recorded destination identity changed: ${id}`);
    }
    index.set(id, observed);
  }
  return index;
}

function prose(value) {
  return String(value ?? "").replaceAll("@", "@\u200b");
}

export function renderMigratedIssue(record, { repository, archivePath, index, records }) {
  const archive = `https://github.com/${repository}/blob/main/${archivePath}`;
  const sourceDigest = crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
  const sections = [
    `<!-- dure-beads-migration:v1 ${record.id} -->`,
    `Migrated from \`${record.id}\`. Original state: **${record.status}**; priority: **P${record.priority}**; type: **${record.issue_type}**.`,
    `Original execution owner: \`${prose(record.assignee || "unassigned")}\`. Created: ${record.created_at}; last source update: ${record.updated_at}.`,
    `The complete original record, including metadata and comments, is preserved in the [source archive](${archive}). Source record SHA256: \`${sourceDigest}\`.`,
  ];
  for (const [field, title] of [["description", "Description"], ["acceptance_criteria", "Acceptance criteria"], ["design", "Design"], ["notes", "Handoff notes"]]) {
    if (record[field]) sections.push(`## ${title}\n\n${prose(record[field])}`);
  }
  if (record.dependencies?.length) {
    sections.push("## Original relationships\n\n" + record.dependencies.map((dependency) => {
      const target = records.get(dependency.depends_on_id);
      const destination = index.get(dependency.depends_on_id);
      const url = destination?.url ?? (target?.status === "closed"
        ? archive
        : `https://github.com/${repository}/issues?q=${encodeURIComponent(`is:issue "${dependency.depends_on_id}"`)}`);
      return `- ${dependency.type}: [${dependency.depends_on_id}](${url}) (source state: ${target?.status ?? "external"})`;
    }).join("\n"));
  }
  if (record.comments?.length) {
    sections.push("## Original comments\n\n" + record.comments.map((comment) =>
      `### ${prose(comment.author ?? comment.created_by ?? "Original author")} — ${comment.created_at ?? "date unavailable"}\n\n${prose(comment.text ?? comment.body ?? JSON.stringify(comment))}`,
    ).join("\n\n"));
  }
  let body = sections.join("\n\n");
  if ([...body].length > 60_000 || Buffer.byteLength(body) > 240_000) {
    body = sections.slice(0, 4).join("\n\n") + "\n\n## Description\n\n" + prose(record.description).slice(0, 24_000)
      + "\n\nThis record exceeds GitHub's issue-body limit. Read its complete acceptance criteria, handoff notes, relationships, and comments in the linked source archive; no source fields were discarded.";
  }
  const status = { in_progress: "in-progress", open: "open", blocked: "blocked", deferred: "deferred" }[record.status];
  if (!status) throw new Error(`Closed source issue must remain archived: ${record.id}`);
  return {
    title: [...record.title].slice(0, 250).join(""),
    body,
    labels: ["source:beads", `priority:p${record.priority}`, `type:${record.issue_type}`, `status:${status}`],
  };
}

export function orderMigrationIssues(records) {
  const issues = records.filter((record) => record._type === "issue" && record.status !== "closed");
  const remaining = new Map(issues.map((record) => [record.id, record]));
  const result = [];
  while (remaining.size) {
    const next = [...remaining.values()].find((record) =>
      !(record.dependencies ?? []).some((dependency) => remaining.has(dependency.depends_on_id)),
    ) ?? remaining.values().next().value;
    result.push(next);
    remaining.delete(next.id);
  }
  return result;
}
