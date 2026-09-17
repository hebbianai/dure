//! Workspace command selection is independent of a viewer or input controller.
use crate::browser_resource::{
    BrowserResourceGeneration, BrowserResourceIdentity, BrowserWorkspaceId, counter,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::num::NonZeroU64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserWorkspaceTarget {
    pub workspace_id: BrowserWorkspaceId,
    pub generation: BrowserResourceGeneration,
    #[serde(with = "counter")]
    pub revision: NonZeroU64,
    #[serde(deserialize_with = "deserialize_resource")]
    pub current_resource: Option<BrowserResourceIdentity>,
}

// Explicit null distinguishes no selection from an older omitted projection.
fn deserialize_resource<'de, D>(
    deserializer: D,
) -> Result<Option<BrowserResourceIdentity>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_target_preserves_large_counters_and_explicit_empty_selection() {
        let wire = json!({"workspace_id":"workspace:one","generation":"generation:one",
            "revision":"18446744073709551615","current_resource":null});
        let target: BrowserWorkspaceTarget = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(target.revision.get(), u64::MAX);
        assert_eq!(serde_json::to_value(target).unwrap(), wire);
        for revision in [
            json!(0),
            json!("0"),
            json!("01"),
            json!("18446744073709551616"),
        ] {
            let mut malformed = wire.clone();
            malformed["revision"] = revision;
            assert!(serde_json::from_value::<BrowserWorkspaceTarget>(malformed).is_err());
        }
        let mut missing = wire;
        missing.as_object_mut().unwrap().remove("current_resource");
        assert!(serde_json::from_value::<BrowserWorkspaceTarget>(missing).is_err());
    }
}
