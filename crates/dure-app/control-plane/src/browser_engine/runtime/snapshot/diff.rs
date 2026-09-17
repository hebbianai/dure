// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/diff.rs. License: ../environment/device/LICENSE-agent-browser.

use serde_json::{Value, json};
use similar::{ChangeTag, DiffableStr, TextDiff};
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub(super) async fn compare(before: String, after: String) -> Result<Value, &'static str> {
    tokio::task::spawn_blocking(move || compare_text(&before, &after))
        .await
        .map_err(|_| "browser_diff_worker_failed")?
}

/// Compare the exact observed text, retaining the upstream unified diff and
/// line counts. The snapshot owner bounds both inputs and the final response.
fn compare_text(before: &str, after: &str) -> Result<Value, &'static str> {
    if before == after {
        return Ok(
            json!({"diff":"","additions":0,"removals":0,"unchanged":before.lines().count(),"changed":false}),
        );
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    let old = before.tokenize_lines();
    let new = after.tokenize_lines();
    let (smaller, larger) = if old.len() <= new.len() {
        (&old, &new)
    } else {
        (&new, &old)
    };
    let shared = smaller.iter().copied().collect::<HashSet<_>>();
    let disjoint = larger.iter().all(|line| !shared.contains(line));
    let mut config = TextDiff::configure();
    config.newline_terminated(true);
    if disjoint {
        // Without a shared line, a complete replacement is the exact Myers
        // result. A zero search budget obtains that replacement through the
        // library's existing operation normalization and unified formatter.
        config.timeout(Duration::ZERO);
    } else {
        config.deadline(deadline);
    }
    let comparison = config.diff_slices(&old, &new);
    if !disjoint && Instant::now() >= deadline {
        return Err("browser_diff_timeout");
    }
    let (mut additions, mut removals, mut unchanged) = (0, 0, 0);
    for change in comparison.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => removals += 1,
            ChangeTag::Equal => unchanged += 1,
        }
    }
    Ok(json!({
        "diff":comparison.unified_diff().context_radius(3).header("before", "after").to_string(),
        "additions":additions,"removals":removals,"unchanged":unchanged,
        "changed":additions > 0 || removals > 0,
    }))
}

#[cfg(test)]
mod tests {
    fn compare(before: &str, after: &str) -> serde_json::Value {
        super::compare_text(before, after).unwrap()
    }

    #[test]
    fn unicode_replacement_and_final_newlines_preserve_unified_counts() {
        let difference = compare("같음\n이전\n", "같음\n새 값\n");
        assert_eq!(difference["additions"], 1);
        assert_eq!(difference["removals"], 1);
        assert_eq!(difference["unchanged"], 1);
        assert_eq!(difference["changed"], true);
        assert_eq!(
            difference["diff"],
            "--- before\n+++ after\n@@ -1,2 +1,2 @@\n 같음\n-이전\n+새 값\n"
        );
        let newline = compare("a", "a\n");
        assert_eq!(newline["changed"], true);
        assert!(
            newline["diff"]
                .as_str()
                .unwrap()
                .contains("No newline at end of file")
        );
    }

    #[test]
    fn empty_baseline_adds_all_lines_and_identical_text_has_no_diff() {
        let identical = compare("제목\n내용\n", "제목\n내용\n");
        assert_eq!(identical["diff"], "");
        assert_eq!(identical["unchanged"], 2);
        assert_eq!(identical["changed"], false);
        let new = compare("", "제목\n내용\n");
        assert_eq!(new["additions"], 2);
        assert_eq!(new["removals"], 0);
        assert_eq!(compare("", "")["unchanged"], 0);
    }

    #[test]
    fn disjoint_large_baselines_complete_in_both_directions() {
        let large = "old line with a long name\n".repeat(13000);
        let current = "- heading 수정 제목\n- button 누르기";
        for (before, after, additions, removals) in
            [(&*large, current, 2, 13000), (current, &*large, 13000, 2)]
        {
            let result = compare(before, after);
            assert_eq!(result["additions"], additions);
            assert_eq!(result["removals"], removals);
            assert_eq!(result["unchanged"], 0);
            assert_eq!(result["changed"], true);
            assert!(result["diff"].as_str().unwrap().contains("수정 제목"));
        }
    }

    #[test]
    fn optimized_output_matches_unbounded_upstream_myers() {
        use similar::{ChangeTag, TextDiff};
        let corpus = [
            "",
            "a",
            "b",
            "a\n",
            "b\n",
            "a\nb\n",
            "b\na\n",
            "a\na\nb",
            "b\na\na",
            "\n\n",
            "\r",
            "a\r\nb\r",
            "한글\n🙂",
            "새 값\r\n",
        ];
        for before in corpus {
            for after in corpus {
                let reference = TextDiff::from_lines(before, after);
                let (mut additions, mut removals, mut unchanged) = (0, 0, 0);
                for change in reference.iter_all_changes() {
                    match change.tag() {
                        ChangeTag::Insert => additions += 1,
                        ChangeTag::Delete => removals += 1,
                        ChangeTag::Equal => unchanged += 1,
                    }
                }
                // The pinned native implementation counts identical inputs
                // with str::lines(), including its distinct lone-CR behavior.
                if before == after {
                    unchanged = before.lines().count();
                }
                assert_eq!(
                    compare(before, after),
                    serde_json::json!({
                        "diff": reference.unified_diff().context_radius(3)
                            .header("before", "after").to_string(),
                        "additions": additions, "removals": removals,
                        "unchanged": unchanged, "changed": additions > 0 || removals > 0,
                    }),
                    "{before:?} -> {after:?}"
                );
            }
        }
    }
}
