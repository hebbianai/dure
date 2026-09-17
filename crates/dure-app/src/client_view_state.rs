use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

use crate::DomainStoreErrorV1;

pub const CLIENT_VIEW_STATE_SCHEMA_VERSION_V1: u16 = 1;
pub const MAX_CLIENT_VIEWS_PER_CLIENT_V1: usize = 64;
pub const MAX_CLIENT_VIEW_LAYOUT_SLOTS_V1: usize = 128;
pub const MAX_CLIENT_VIEW_VIEWPORTS_V1: usize = 128;
pub const MAX_CLIENT_VIEW_FILTERS_V1: usize = 64;
pub const MAX_CLIENT_VIEW_SUBSCRIPTIONS_V1: usize = 128;
pub const MAX_CLIENT_VIEW_STATE_BYTES_V1: usize = 64 * 1024;

const MAX_ID_BYTES: usize = 160;
const MAX_VIEW_TOKEN_BYTES: usize = 512;
const MAX_SCROLL_OFFSET_ROWS: i32 = 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientViewIdErrorV1 {
    pub value: String,
    pub reason: &'static str,
}

impl fmt::Display for ClientViewIdErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid client view id {:?}: {}",
            self.value, self.reason
        )
    }
}

impl std::error::Error for ClientViewIdErrorV1 {}

fn validate_id(value: &str) -> Result<(), ClientViewIdErrorV1> {
    if value.is_empty() {
        return Err(ClientViewIdErrorV1 {
            value: value.into(),
            reason: "must not be empty",
        });
    }
    if value.len() > MAX_ID_BYTES {
        return Err(ClientViewIdErrorV1 {
            value: value.into(),
            reason: "exceeds the bounded identifier length",
        });
    }
    if !value
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(ClientViewIdErrorV1 {
            value: value.into(),
            reason: "must start with an ASCII letter or digit",
        });
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(ClientViewIdErrorV1 {
            value: value.into(),
            reason: "contains characters outside [A-Za-z0-9._:-]",
        });
    }
    Ok(())
}

macro_rules! client_view_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, ClientViewIdErrorV1> {
                let value = value.into();
                validate_id(&value)?;
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let value = String::deserialize(deserializer)?;
                Self::new(value).map_err(serde::de::Error::custom)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

client_view_id!(TenantIdV1);
client_view_id!(UserIdV1);
client_view_id!(ClientIdV1);
client_view_id!(ClientInstanceIdV1);
client_view_id!(ClientViewIdV1);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewNamespaceV1 {
    pub tenant_id: TenantIdV1,
    pub user_id: UserIdV1,
    pub client_id: ClientIdV1,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewIdentityV1 {
    pub namespace: ClientViewNamespaceV1,
    pub client_generation: i64,
    pub client_instance_id: ClientInstanceIdV1,
    pub view_id: ClientViewIdV1,
}

impl ClientViewIdentityV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_positive("clientGeneration", self.client_generation)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewAuthorityV1 {
    pub schema_version: u16,
    pub namespace: ClientViewNamespaceV1,
    pub client_generation: i64,
    pub client_instance_id: ClientInstanceIdV1,
    pub updated_at_ms: i64,
}

impl ClientViewAuthorityV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        validate_positive("clientGeneration", self.client_generation)?;
        validate_timestamp(self.updated_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewGenerationAdvanceRequestV1 {
    pub schema_version: u16,
    pub namespace: ClientViewNamespaceV1,
    pub idempotency_key: String,
    /// Zero initializes generation one. Positive values replace that exact generation.
    pub expected_generation: i64,
    /// Absent only for initialization; replacement must name the exact prior instance.
    pub expected_instance_id: Option<ClientInstanceIdV1>,
    pub next_instance_id: ClientInstanceIdV1,
}

impl ClientViewGenerationAdvanceRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        if self.expected_generation < 0 {
            return invalid("expectedGeneration", "must not be negative");
        }
        match (self.expected_generation, &self.expected_instance_id) {
            (0, None) => {}
            (0, Some(_)) => {
                return invalid(
                    "expectedInstanceId",
                    "must be absent when initializing generation one",
                );
            }
            (_, None) => {
                return invalid(
                    "expectedInstanceId",
                    "must identify the exact generation being replaced",
                );
            }
            (_, Some(instance)) if instance == &self.next_instance_id => {
                return invalid(
                    "nextInstanceId",
                    "must differ from the instance being replaced",
                );
            }
            (_, Some(_)) => {}
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewGenerationReceiptV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub authority: ClientViewAuthorityV1,
}

impl ClientViewGenerationReceiptV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        self.authority.validate()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewLayoutSlotV1 {
    pub pane_id: String,
    pub group_id: String,
    pub order: u16,
    /// Relative size in basis points, bounded to (0, 10000].
    pub size_basis_points: u16,
}

impl ClientViewLayoutSlotV1 {
    fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_view_token("layout.paneId", &self.pane_id)?;
        validate_view_token("layout.groupId", &self.group_id)?;
        if self.size_basis_points == 0 || self.size_basis_points > 10_000 {
            return invalid("layout.sizeBasisPoints", "must be between 1 and 10000");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewViewportV1 {
    pub pane_id: String,
    /// Hmux output sequence is only a presentation anchor, never runtime authority.
    pub anchor_sequence: Option<u64>,
    pub scroll_offset_rows: i32,
}

impl ClientViewViewportV1 {
    fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_view_token("viewports.paneId", &self.pane_id)?;
        if self.scroll_offset_rows.unsigned_abs() > MAX_SCROLL_OFFSET_ROWS as u32 {
            return invalid(
                "viewports.scrollOffsetRows",
                "exceeds the bounded viewport offset",
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewFilterV1 {
    /// A registered filter identifier. Free-form filter expressions are not persisted.
    pub filter_id: String,
    pub enabled: bool,
}

impl ClientViewFilterV1 {
    fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_view_token("filters.filterId", &self.filter_id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ClientViewSubscriptionTopicV1 {
    AgentActivity,
    SessionOutput,
    WorkspaceChanges,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewSubscriptionV1 {
    pub topic: ClientViewSubscriptionTopicV1,
    pub resource_id: String,
}

impl ClientViewSubscriptionV1 {
    fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_view_token("subscriptions.resourceId", &self.resource_id)
    }
}

/// Bounded presentation-only state. Runtime bytes, process identity, controller
/// leases and credential material have no fields in this contract.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewPresentationV1 {
    pub selected_session_id: Option<String>,
    pub selected_space_id: Option<String>,
    pub selected_pane_id: Option<String>,
    pub layout: Vec<ClientViewLayoutSlotV1>,
    pub viewports: Vec<ClientViewViewportV1>,
    pub filters: Vec<ClientViewFilterV1>,
    pub subscriptions: Vec<ClientViewSubscriptionV1>,
}

impl ClientViewPresentationV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        for (field, value) in [
            ("selectedSessionId", &self.selected_session_id),
            ("selectedSpaceId", &self.selected_space_id),
            ("selectedPaneId", &self.selected_pane_id),
        ] {
            if let Some(value) = value {
                validate_view_token(field, value)?;
            }
        }
        validate_limit("layout", self.layout.len(), MAX_CLIENT_VIEW_LAYOUT_SLOTS_V1)?;
        validate_limit(
            "viewports",
            self.viewports.len(),
            MAX_CLIENT_VIEW_VIEWPORTS_V1,
        )?;
        validate_limit("filters", self.filters.len(), MAX_CLIENT_VIEW_FILTERS_V1)?;
        validate_limit(
            "subscriptions",
            self.subscriptions.len(),
            MAX_CLIENT_VIEW_SUBSCRIPTIONS_V1,
        )?;

        let mut pane_ids = BTreeSet::new();
        let mut group_orders = BTreeSet::new();
        for slot in &self.layout {
            slot.validate()?;
            if !pane_ids.insert(slot.pane_id.as_str()) {
                return invalid("layout", "must not contain duplicate paneId values");
            }
            if !group_orders.insert((slot.group_id.as_str(), slot.order)) {
                return invalid("layout", "must not contain duplicate group order values");
            }
        }
        let mut viewport_panes = BTreeSet::new();
        for viewport in &self.viewports {
            viewport.validate()?;
            if !viewport_panes.insert(viewport.pane_id.as_str()) {
                return invalid("viewports", "must not contain duplicate paneId values");
            }
        }
        let mut filter_ids = BTreeSet::new();
        for filter in &self.filters {
            filter.validate()?;
            if !filter_ids.insert(filter.filter_id.as_str()) {
                return invalid("filters", "must not contain duplicate filterId values");
            }
        }
        let mut subscriptions = BTreeSet::new();
        for subscription in &self.subscriptions {
            subscription.validate()?;
            if !subscriptions.insert((&subscription.topic, subscription.resource_id.as_str())) {
                return invalid("subscriptions", "must not contain duplicate subscriptions");
            }
        }
        let encoded =
            serde_json::to_vec(self).map_err(|error| DomainStoreErrorV1::InvalidRecord {
                field: "presentation",
                reason: error.to_string(),
            })?;
        if encoded.len() > MAX_CLIENT_VIEW_STATE_BYTES_V1 {
            return invalid("presentation", "exceeds the bounded encoded size");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewRecordV1 {
    pub schema_version: u16,
    pub identity: ClientViewIdentityV1,
    pub revision: i64,
    pub presentation: ClientViewPresentationV1,
    pub updated_at_ms: i64,
}

impl ClientViewRecordV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.identity.validate()?;
        validate_positive("revision", self.revision)?;
        self.presentation.validate()?;
        validate_timestamp(self.updated_at_ms)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewWriteRequestV1 {
    pub schema_version: u16,
    pub identity: ClientViewIdentityV1,
    pub idempotency_key: String,
    /// Zero means this view does not exist in the active client generation.
    pub expected_revision: i64,
    pub presentation: ClientViewPresentationV1,
}

impl ClientViewWriteRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        self.identity.validate()?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        if self.expected_revision < 0 {
            return invalid("expectedRevision", "must not be negative");
        }
        self.presentation.validate()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientViewWriteReceiptV1 {
    pub schema_version: u16,
    pub idempotency_key: String,
    pub record: ClientViewRecordV1,
}

impl ClientViewWriteReceiptV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        validate_schema(self.schema_version)?;
        validate_token("idempotencyKey", &self.idempotency_key)?;
        self.record.validate()
    }
}

fn validate_schema(schema_version: u16) -> Result<(), DomainStoreErrorV1> {
    if schema_version != CLIENT_VIEW_STATE_SCHEMA_VERSION_V1 {
        return invalid("schemaVersion", "unsupported client view state schema");
    }
    Ok(())
}

fn validate_positive(field: &'static str, value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 1 {
        return invalid(field, "must be positive");
    }
    Ok(())
}

fn validate_timestamp(value: i64) -> Result<(), DomainStoreErrorV1> {
    if value < 0 {
        return invalid("updatedAtMs", "must not be negative");
    }
    Ok(())
}

fn validate_token(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return invalid(field, "must be a bounded opaque token");
    }
    Ok(())
}

fn validate_view_token(field: &'static str, value: &str) -> Result<(), DomainStoreErrorV1> {
    if value.is_empty()
        || value.len() > MAX_VIEW_TOKEN_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return invalid(field, "must be a bounded non-control string");
    }
    Ok(())
}

fn validate_limit(
    field: &'static str,
    actual: usize,
    maximum: usize,
) -> Result<(), DomainStoreErrorV1> {
    if actual > maximum {
        return invalid(field, "exceeds the bounded item count");
    }
    Ok(())
}

fn invalid<T>(field: &'static str, reason: &str) -> Result<T, DomainStoreErrorV1> {
    Err(DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ClientViewIdentityV1 {
        ClientViewIdentityV1 {
            namespace: ClientViewNamespaceV1 {
                tenant_id: TenantIdV1::new("tenant-1").unwrap(),
                user_id: UserIdV1::new("user-1").unwrap(),
                client_id: ClientIdV1::new("client-1").unwrap(),
            },
            client_generation: 1,
            client_instance_id: ClientInstanceIdV1::new("instance-1").unwrap(),
            view_id: ClientViewIdV1::new("view-1").unwrap(),
        }
    }

    #[test]
    fn typed_presentation_round_trips_without_runtime_or_secret_fields() {
        let request = ClientViewWriteRequestV1 {
            schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
            identity: identity(),
            idempotency_key: "write-1".into(),
            expected_revision: 0,
            presentation: ClientViewPresentationV1 {
                selected_session_id: Some("session-1".into()),
                selected_space_id: Some("space-a".into()),
                selected_pane_id: Some("agent:one".into()),
                layout: vec![ClientViewLayoutSlotV1 {
                    pane_id: "agent:one".into(),
                    group_id: "left".into(),
                    order: 0,
                    size_basis_points: 6_000,
                }],
                viewports: vec![ClientViewViewportV1 {
                    pane_id: "agent:one".into(),
                    anchor_sequence: Some(42),
                    scroll_offset_rows: -7,
                }],
                filters: vec![ClientViewFilterV1 {
                    filter_id: "running-only".into(),
                    enabled: true,
                }],
                subscriptions: vec![ClientViewSubscriptionV1 {
                    topic: ClientViewSubscriptionTopicV1::SessionOutput,
                    resource_id: "session-1".into(),
                }],
            },
        };
        request.validate().unwrap();

        let encoded = serde_json::to_value(&request).unwrap();
        assert_eq!(encoded["presentation"]["selectedSessionId"], "session-1");
        let mut with_secret = encoded;
        with_secret["presentation"]["credential"] = serde_json::json!("secret");
        assert!(serde_json::from_value::<ClientViewWriteRequestV1>(with_secret).is_err());
    }

    #[test]
    fn generation_advance_requires_an_exact_replacement_identity() {
        let namespace = identity().namespace;
        ClientViewGenerationAdvanceRequestV1 {
            schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
            namespace: namespace.clone(),
            idempotency_key: "initialize".into(),
            expected_generation: 0,
            expected_instance_id: None,
            next_instance_id: ClientInstanceIdV1::new("instance-1").unwrap(),
        }
        .validate()
        .unwrap();
        assert!(
            ClientViewGenerationAdvanceRequestV1 {
                schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
                namespace,
                idempotency_key: "replace".into(),
                expected_generation: 1,
                expected_instance_id: None,
                next_instance_id: ClientInstanceIdV1::new("instance-2").unwrap(),
            }
            .validate()
            .is_err()
        );
    }
}
