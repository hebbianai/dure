//! Source-attributed console observations across a page's document lifetimes.

use crate::browser_resource::BrowserPageIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(try_from = "u64")]
pub struct BrowserConsoleLimit(u64);

impl Default for BrowserConsoleLimit {
    fn default() -> Self {
        Self(100)
    }
}

impl TryFrom<u64> for BrowserConsoleLimit {
    type Error = &'static str;
    fn try_from(value: u64) -> Result<Self, Self::Error> {
        if value == 0 {
            return Err("browser_console_limit_invalid");
        }
        Ok(Self(value))
    }
}

impl BrowserConsoleLimit {
    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(try_from = "String")]
pub struct BrowserConsoleCursor(u64);

impl TryFrom<String> for BrowserConsoleCursor {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        let sequence = value
            .parse::<u64>()
            .map_err(|_| "browser_console_cursor_invalid")?;
        if sequence == 0 || sequence.to_string() != value {
            return Err("browser_console_cursor_invalid");
        }
        Ok(Self(sequence))
    }
}

impl BrowserConsoleCursor {
    pub fn get(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserConsoleQuery {
    #[serde(default)]
    pub limit: BrowserConsoleLimit,
    pub before: Option<BrowserConsoleCursor>,
    pub kind: Option<BrowserConsoleKind>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserConsoleKind {
    Console,
    Exception,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserConsoleEntry {
    pub sequence: String,
    pub source: String,
    pub kind: BrowserConsoleKind,
    pub level: String,
    pub text: String,
    /// Engine-reported Unix milliseconds; no wall-clock substitute is invented.
    pub timestamp: f64,
    pub url: Option<String>,
    /// Zero-based source position when the engine reports it.
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub metadata_truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BrowserConsoleSnapshot {
    /// Current page scope. Entries survive document commits and retain their
    /// own source location; they do not claim this current document revision.
    pub page: BrowserPageIdentity,
    pub entries: Vec<BrowserConsoleEntry>,
    pub truncated: bool,
    pub history_truncated: bool,
    /// Continue through older retained entries without repeating page activity.
    pub next_before: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_query_normalizes_limits_and_lossless_cursors_once() {
        let query: BrowserConsoleQuery = serde_json::from_str("{}").unwrap();
        assert_eq!(query.limit.get(), 100);
        assert!(query.before.is_none());
        assert!(query.kind.is_none());
        let query: BrowserConsoleQuery = serde_json::from_str(r#"{"kind":"exception"}"#).unwrap();
        assert_eq!(query.kind, Some(BrowserConsoleKind::Exception));
        let query: BrowserConsoleQuery = serde_json::from_str(
            r#"{"limit":18446744073709551615,"before":"18446744073709551615"}"#,
        )
        .unwrap();
        assert_eq!(query.limit.get(), u64::MAX);
        assert_eq!(query.before.unwrap().get(), u64::MAX);
        for invalid in [
            r#"{"limit":0}"#,
            r#"{"limit":-1}"#,
            r#"{"limit":1.5}"#,
            r#"{"limit":"1"}"#,
            r#"{"limit":18446744073709551616}"#,
            r#"{"before":1}"#,
            r#"{"before":"01"}"#,
            r#"{"before":"0"}"#,
            r#"{"before":"+1"}"#,
            r#"{"before":"18446744073709551616"}"#,
            r#"{"unknown":1}"#,
            r#"{"kind":"error"}"#,
            r#"{"kind":1}"#,
        ] {
            assert!(
                serde_json::from_str::<BrowserConsoleQuery>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn console_wire_round_trip_preserves_korean_metadata_and_decimal_sequence() {
        let value = serde_json::json!({"sequence":"9007199254740993","source":"frame:1","kind":"exception","level":"error","text":"비동기 오류","timestamp":1700000000000.25,"url":"https://example.test/한글","line":0,"column":8,"metadata_truncated":false});
        let entry: BrowserConsoleEntry = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(entry).unwrap(), value);
    }
}
