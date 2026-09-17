use super::{clip, user_text};
use serde_json::Value;
use std::{fs, path::Path};

/// Read provider-owned names from the existing bounded transcript windows.
/// User names outrank generated names even when only the prefix has the rename.
pub(super) fn named_title(prefix: &str, suffix: Option<&str>, id: &str) -> Option<String> {
    let mut generated = None;
    for content in [suffix, Some(prefix)].into_iter().flatten() {
        for value in content
            .lines()
            .rev()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        {
            if !matches!(
                value.get("type").and_then(Value::as_str),
                Some("custom-title" | "ai-title" | "summary")
            ) || value
                .get("sessionId")
                .is_some_and(|session| session.as_str() != Some(id))
            {
                continue;
            }
            let title = |field| {
                value.get(field).and_then(Value::as_str).and_then(|text| {
                    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    (!text.is_empty()).then(|| clip(&text))
                })
            };
            if let Some(custom) = title("customTitle") {
                return Some(custom);
            }
            if generated.is_none() {
                generated = title("aiTitle");
            }
        }
    }
    generated
}

/// Keep the first meaningful user UUID as the segment identity. An unnamed
/// conversation retains the picker's latest-user-message title.
pub(super) fn title_and_identity(path: &Path) -> (String, Option<String>) {
    let mut identity = None;
    let mut title = None;
    if let Ok(content) = fs::read_to_string(path) {
        for value in content
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        {
            if value.get("type").and_then(Value::as_str) != Some("user") {
                continue;
            }
            if let Some(text) = user_text(&value) {
                let text = text.trim();
                if !text.is_empty() && !text.starts_with('<') && !text.starts_with("Caveat:") {
                    if identity.is_none() {
                        identity = value
                            .get("uuid")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                    }
                    title = Some(clip(text));
                }
            }
        }
        if let Some(id) = path.file_stem().and_then(|value| value.to_str()) {
            title = named_title(&content, None, id).or(title);
        }
    }
    (title.unwrap_or_else(|| "(Untitled)".into()), identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_windows_preserve_custom_names_over_generated_names() {
        let prefix =
            r#"{"type":"custom-title","customTitle":"  My\n session  ","sessionId":"one"}"#;
        let suffix = r#"{"type":"ai-title","aiTitle":"Generated name","sessionId":"one"}
{"type":"custom-title","customTitle":"Other conversation","sessionId":"two"}
{"type":"custom-title","customTitle":"   ","sessionId":"one"}
{"type":"user","customTitle":"Prompt data","message":{"content":"Continue"}}
{"type":"custom-title","customTitle":"partial"#;
        assert_eq!(
            named_title(prefix, Some(suffix), "one").as_deref(),
            Some("My session")
        );
        assert_eq!(
            named_title("", Some(suffix), "one").as_deref(),
            Some("Generated name")
        );
    }

    #[test]
    fn metadata_without_a_name_leaves_the_prompt_fallback_available() {
        assert_eq!(
            named_title(r#"{"type":"summary","summary":"A summary"}"#, None, "one"),
            None
        );
        assert_eq!(
            named_title(
                r#"{"type":"summary","customTitle":"Named session"}"#,
                None,
                "one"
            )
            .as_deref(),
            Some("Named session")
        );
    }
}
