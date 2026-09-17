//! Browser resource identity and input authority, independent of PTY sessions.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::num::NonZeroU64;

pub const BROWSER_RESOURCE_CAPABILITY: &str = "browser_resource_v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidBrowserIdentifier;

impl fmt::Display for InvalidBrowserIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "browser identifier must start with an ASCII letter or digit and contain 1..160 ASCII letters, digits, '.', '_', ':', or '-'",
        )
    }
}

impl std::error::Error for InvalidBrowserIdentifier {}

fn identifier(value: String) -> Result<String, InvalidBrowserIdentifier> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        || !value.as_bytes()[0].is_ascii_alphanumeric()
    {
        return Err(InvalidBrowserIdentifier);
    }
    Ok(value)
}

macro_rules! browser_identifier {
    ($name:ident) => {
        #[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidBrowserIdentifier> {
                identifier(value.into()).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

browser_identifier!(BrowserResourceId);
browser_identifier!(BrowserResourceGeneration);
browser_identifier!(BrowserWorkspaceId);
browser_identifier!(BrowserPageId);
browser_identifier!(BrowserControllerId);
browser_identifier!(BrowserOperationId);
browser_identifier!(BrowserDocumentId);
browser_identifier!(BrowserElementId);
browser_identifier!(BrowserTargetId);
browser_identifier!(BrowserInstanceId);
browser_identifier!(BrowserDialogSourceId);
browser_identifier!(BrowserFrameId);

/// A user-assigned page name, distinct from its opaque identity and title.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct BrowserPageLabel(String);

impl BrowserPageLabel {
    pub fn new(value: impl Into<String>) -> Result<Self, &'static str> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 160
            || !value.as_bytes()[0].is_ascii_alphabetic()
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        {
            return Err("browser_tab_label_invalid");
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for BrowserPageLabel {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

// Keep browser fences exact in JavaScript clients. Zero is never an issued
// revision, and alternate decimal spellings do not represent another fence.
pub(crate) mod counter {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    use std::num::NonZeroU64;

    pub fn serialize<S: Serializer>(value: &NonZeroU64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<NonZeroU64, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(D::Error::custom(
                "expected a canonical positive decimal counter",
            ));
        }
        value.parse().map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserResourceIdentity {
    pub resource_id: BrowserResourceId,
    pub generation: BrowserResourceGeneration,
    pub workspace_id: BrowserWorkspaceId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserPageIdentity {
    pub resource: BrowserResourceIdentity,
    pub page_id: BrowserPageId,
    #[serde(with = "counter")]
    pub document_revision: NonZeroU64,
}

/// A child document inside one exact page. Frame revisions never survive a
/// document replacement, even when the embedding element and frame ID do.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserFrameIdentity {
    pub page: BrowserPageIdentity,
    pub frame_id: BrowserFrameId,
    #[serde(with = "counter")]
    pub document_revision: NonZeroU64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserSnapshotIdentity {
    pub page: BrowserPageIdentity,
    #[serde(with = "counter")]
    pub revision: NonZeroU64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserElementReference {
    pub snapshot: BrowserSnapshotIdentity,
    pub element: BrowserElementId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserControllerLease {
    pub resource: BrowserResourceIdentity,
    pub controller_id: BrowserControllerId,
    #[serde(with = "counter")]
    pub epoch: NonZeroU64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserActionAuthority {
    pub lease: BrowserControllerLease,
    pub page: BrowserPageIdentity,
    pub operation_id: BrowserOperationId,
    #[serde(with = "counter")]
    pub command_sequence: NonZeroU64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserActionOutcome {
    Completed,
    RejectedBeforeDispatch,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserResourcePhase {
    Ready,
    OutcomeUnknown,
    Retiring,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserControlProjection {
    pub resource: BrowserResourceIdentity,
    #[serde(with = "counter")]
    pub revision: NonZeroU64,
    pub phase: BrowserResourcePhase,
    pub controller: Option<BrowserControllerLease>,
    pub requested_controller: Option<BrowserControllerId>,
    pub in_flight: Option<BrowserOperationId>,
    #[serde(with = "counter")]
    pub next_command_sequence: NonZeroU64,
    /// The controller's current browser target, independent of viewer layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_page: Option<BrowserPageIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<crate::browser_pointer::BrowserPointerContact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyboard: Option<crate::browser_keyboard::BrowserKeyboardContact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub touch: Option<crate::browser_pointer::BrowserTouchContact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog_response: Option<BrowserOperationId>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_identity_preserves_both_document_fences_and_rejects_ambiguous_wire_values() {
        let value = serde_json::json!({
            "page": {"resource":{"resource_id":"r","generation":"g","workspace_id":"w"},
                     "page_id":"page:1","document_revision":"9007199254740993"},
            "frame_id":"frame:1", "document_revision":"18446744073709551615"
        });
        let frame: BrowserFrameIdentity = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(frame.page.document_revision.get(), 9_007_199_254_740_993);
        assert_eq!(frame.document_revision.get(), u64::MAX);
        assert_eq!(serde_json::to_value(frame).unwrap(), value);
        for invalid in [
            serde_json::json!(1),
            serde_json::json!("0"),
            serde_json::json!("01"),
            serde_json::json!("18446744073709551616"),
        ] {
            let mut malformed = value.clone();
            malformed["document_revision"] = invalid;
            assert!(serde_json::from_value::<BrowserFrameIdentity>(malformed).is_err());
        }
        for invalid in ["", "../frame", "a b"] {
            let mut malformed = value.clone();
            malformed["frame_id"] = invalid.into();
            assert!(serde_json::from_value::<BrowserFrameIdentity>(malformed).is_err());
        }
        let mut unknown = value;
        unknown["force"] = true.into();
        assert!(serde_json::from_value::<BrowserFrameIdentity>(unknown).is_err());
    }

    #[test]
    fn input_projection_is_additive_for_previous_control_snapshots() {
        let old = serde_json::json!({"resource":{"resource_id":"r","generation":"g","workspace_id":"w"},"revision":"1","phase":"ready","controller":null,"requested_controller":null,"in_flight":null,"next_command_sequence":"1"});
        let parsed: BrowserControlProjection = serde_json::from_value(old.clone()).unwrap();
        assert!(parsed.pointer.is_none());
        assert!(parsed.keyboard.is_none());
        assert!(parsed.touch.is_none());
        assert!(parsed.current_page.is_none());
        assert_eq!(serde_json::to_value(parsed).unwrap(), old);
    }

    #[test]
    fn current_page_projection_keeps_exact_document_fences() {
        let mut value = serde_json::json!({"resource":{"resource_id":"r","generation":"g","workspace_id":"w"},"revision":"1","phase":"ready","controller":null,"requested_controller":null,"in_flight":null,"next_command_sequence":"1","current_page":{"resource":{"resource_id":"r","generation":"g","workspace_id":"w"},"page_id":"page:2","document_revision":"18446744073709551615"}});
        let parsed: BrowserControlProjection = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(
            parsed
                .current_page
                .as_ref()
                .unwrap()
                .document_revision
                .get(),
            u64::MAX
        );
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        for invalid in [serde_json::json!(1), serde_json::json!("01")] {
            value["current_page"]["document_revision"] = invalid;
            assert!(serde_json::from_value::<BrowserControlProjection>(value.clone()).is_err());
        }
    }

    #[test]
    fn raw_identifiers_are_normalized_only_at_ingress() {
        for value in ["", "../page", "page/1", "a b", "한글", "-page"] {
            let encoded = serde_json::to_string(value).unwrap();
            assert!(serde_json::from_str::<BrowserPageId>(&encoded).is_err());
        }
        assert!(BrowserPageId::new("a".repeat(161)).is_err());
        let page: BrowserPageId = serde_json::from_str("\"page:1\"").unwrap();
        assert_eq!(page.as_str(), "page:1");
        assert_eq!(serde_json::to_string(&page).unwrap(), "\"page:1\"");
    }

    #[test]
    fn page_labels_are_bounded_names_without_normalizing_distinct_inputs() {
        for value in ["docs", "App-2", "my_tab", &"a".repeat(160)] {
            let label: BrowserPageLabel = serde_json::from_value(serde_json::json!(value)).unwrap();
            assert_eq!(label.as_str(), value);
            assert_eq!(serde_json::to_value(label).unwrap(), value);
        }
        for value in [
            "",
            "0",
            " docs",
            "docs ",
            "with space",
            "../outside",
            "page:2",
            "한글",
            &"a".repeat(161),
        ] {
            assert!(
                serde_json::from_value::<BrowserPageLabel>(serde_json::json!(value)).is_err(),
                "{value}"
            );
        }
        assert!(serde_json::from_value::<BrowserPageLabel>(serde_json::json!(7)).is_err());
    }

    #[test]
    fn serialized_leases_reject_zero_epochs_and_unknown_authority() {
        let mut lease = serde_json::json!({
            "resource": {"resource_id":"r", "generation":"g", "workspace_id":"w"},
            "controller_id":"agent", "epoch":"1"
        });
        assert!(serde_json::from_value::<BrowserControllerLease>(lease.clone()).is_ok());
        for invalid in [
            serde_json::json!(0),
            serde_json::json!(1),
            serde_json::json!("0"),
            serde_json::json!("01"),
            serde_json::json!("+1"),
            serde_json::json!(""),
        ] {
            lease["epoch"] = invalid;
            assert!(serde_json::from_value::<BrowserControllerLease>(lease.clone()).is_err());
        }
        lease["epoch"] = u64::MAX.to_string().into();
        let maximum: BrowserControllerLease = serde_json::from_value(lease.clone()).unwrap();
        assert_eq!(maximum.epoch.get(), u64::MAX);
        assert_eq!(serde_json::to_value(maximum).unwrap(), lease);
        lease["force"] = true.into();
        assert!(serde_json::from_value::<BrowserControllerLease>(lease).is_err());
    }
}
