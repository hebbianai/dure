//! Changed provider snapshots, bounded to one turn; no retained provider content.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Evidence {
    snapshots: HashMap<(&'static str, String), [u8; 32]>,
    generated_tokens: Option<(u64, u64)>,
}

impl Evidence {
    pub(super) fn observe(&mut self, method: &str, message: &Value) -> bool {
        match method {
            "item/fileChange/patchUpdated" => self.patch(message).unwrap_or(false),
            "turn/diff/updated" => self.text("diff", "", message.pointer("/params/diff")),
            "item/mcpToolCall/progress" => {
                let Some(item) = message
                    .pointer("/params/itemId")
                    .and_then(super::super::lifecycle::identifier)
                else {
                    return false;
                };
                self.text("mcp", item, message.pointer("/params/message"))
            }
            "thread/tokenUsage/updated" => self.tokens(message).unwrap_or(false),
            _ => false,
        }
    }

    fn changed(&mut self, kind: &'static str, item: &str, digest: [u8; 32]) -> bool {
        let key = (kind, item.to_owned());
        if self.snapshots.get(&key) == Some(&digest)
            || (!self.snapshots.contains_key(&key) && self.snapshots.len() >= 128)
        {
            return false;
        }
        self.snapshots.insert(key, digest);
        true
    }

    fn text(&mut self, kind: &'static str, item: &str, value: Option<&Value>) -> bool {
        let Some(text) = value
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        else {
            return false;
        };
        self.changed(kind, item, Sha256::digest(text.as_bytes()).into())
    }

    fn patch(&mut self, message: &Value) -> Option<bool> {
        let item = super::super::lifecycle::identifier(message.pointer("/params/itemId")?)?;
        let changes = message.pointer("/params/changes")?.as_array()?;
        if changes.is_empty() {
            return None;
        }
        let mut digest = Sha256::new();
        for change in changes {
            let path = change.get("path")?.as_str().filter(|s| !s.is_empty())?;
            let diff = change.get("diff")?.as_str()?;
            let kind = change.pointer("/kind/type")?.as_str()?;
            if !matches!(kind, "add" | "delete" | "update") {
                return None;
            }
            let moved = change
                .pointer("/kind/move_path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if kind == "update" && diff.is_empty() && moved.is_empty() {
                return None;
            }
            // Hash only the schema's work fields, not incidental metadata.
            for text in [path, kind, diff, moved] {
                digest.update((text.len() as u64).to_le_bytes());
                digest.update(text.as_bytes());
            }
        }
        Some(self.changed("patch", item, digest.finalize().into()))
    }

    fn tokens(&mut self, message: &Value) -> Option<bool> {
        let usage = message.pointer("/params/tokenUsage/total")?;
        let current = (
            usage.get("outputTokens")?.as_u64()?,
            usage.get("reasoningOutputTokens")?.as_u64()?,
        );
        let previous = self.generated_tokens.replace(current);
        let Some(previous) = previous else {
            // Cumulative totals may include previous turns. Establish a baseline.
            return Some(false);
        };
        self.generated_tokens = Some((previous.0.max(current.0), previous.1.max(current.1)));
        // Replayed/regressed totals and input/cache/context-only updates are not
        // model-generation evidence. Keep high-water marks when totals regress.
        Some(current.0 >= previous.0 && current.1 >= previous.1 && current != previous)
    }
}
