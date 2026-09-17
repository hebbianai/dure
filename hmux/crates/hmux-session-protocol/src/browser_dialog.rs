//! Page dialogs and exact response identity, independent of the browser adapter.

use crate::browser_resource::{BrowserControlProjection, BrowserPageIdentity, counter};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU64;

pub const MAX_DIALOG_TEXT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserDialogIdentity {
    pub page: BrowserPageIdentity,
    #[serde(with = "counter")]
    pub revision: NonZeroU64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserDialogKind {
    Alert,
    Confirm,
    Prompt,
    BeforeUnload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserDialog {
    pub identity: BrowserDialogIdentity,
    pub kind: BrowserDialogKind,
    pub message: String,
    pub url: String,
    pub default_prompt: String,
    /// At least one observed text field was cut at a UTF-8 boundary.
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct BrowserPromptText(String);

impl TryFrom<String> for BrowserPromptText {
    type Error = &'static str;
    fn try_from(text: String) -> Result<Self, Self::Error> {
        if text.len() > MAX_DIALOG_TEXT_BYTES {
            return Err("browser_dialog_text_invalid");
        }
        Ok(Self(text))
    }
}

impl From<BrowserPromptText> for String {
    fn from(text: BrowserPromptText) -> String {
        text.0
    }
}

impl BrowserPromptText {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserDialogResponse {
    Accept { text: Option<BrowserPromptText> },
    Dismiss {},
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserDialogObservation {
    pub control: BrowserControlProjection,
    pub page: BrowserPageIdentity,
    pub dialog: Option<BrowserDialog>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn responses_parse_bounded_literal_text_and_reject_extra_authority() {
        for value in [
            json!({"kind":"accept"}),
            json!({"kind":"accept","text":"한글\n\u{0}--help"}),
            json!({"kind":"accept","text":""}),
            json!({"kind":"dismiss"}),
        ] {
            assert!(serde_json::from_value::<BrowserDialogResponse>(value).is_ok());
        }
        for value in [
            json!({"kind":"dismiss","text":"x"}),
            json!({"kind":"accept","force":true}),
            json!({"kind":"accept","text":7}),
            json!({"kind":"accept","text":"a".repeat(MAX_DIALOG_TEXT_BYTES+1)}),
        ] {
            assert!(serde_json::from_value::<BrowserDialogResponse>(value).is_err());
        }
        assert!(BrowserPromptText::try_from("a".repeat(MAX_DIALOG_TEXT_BYTES)).is_ok());
    }

    #[test]
    fn dialog_revision_is_an_exact_nonzero_decimal_fence() {
        let mut value = json!({"page":{"resource":{"resource_id":"r","generation":"g","workspace_id":"w"},"page_id":"p","document_revision":"1"},"revision":u64::MAX.to_string()});
        let identity: BrowserDialogIdentity = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(identity).unwrap(), value);
        for invalid in [json!(1), json!("0"), json!("01"), json!("+1")] {
            value["revision"] = invalid;
            assert!(serde_json::from_value::<BrowserDialogIdentity>(value.clone()).is_err());
        }
    }
}
