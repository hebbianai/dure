use super::{
    RuntimeContractError, StandaloneCreateReceipt, StandaloneCreateRequest, read_json_frame,
    validate_identifier, validate_opaque_identity, write_json_frame,
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const STANDALONE_CREATE_OPERATION_SUBCOMMAND: &str = "internal-standalone-create-operation";
pub const STANDALONE_CREATE_OPERATION_CAPABILITY: &str = "standalone_create_operation_v1";
pub const STANDALONE_CREATE_OPERATION_RECONCILE_CAPABILITY: &str =
    "standalone_create_operation_reconcile_v1";
pub const STANDALONE_CREATE_OPERATION_RETIRE_COMPLETED_TARGET_CAPABILITY: &str =
    "standalone_create_operation_retire_completed_target_v1";
pub const STANDALONE_CREATE_OPERATION_RETIREMENT_ACKNOWLEDGE_CAPABILITY: &str =
    "standalone_create_operation_retirement_acknowledge_v1";
pub const STANDALONE_CREATE_OPERATION_SCHEMA_VERSION: u16 = 1;
pub const STANDALONE_CREATE_OPERATION_PROTOCOL_MANIFEST: &str =
    include_str!("../../../protocol/standalone-create-operation-v1.json");

/// Versioned public input for one journaled standalone create operation.
///
/// The caller owns `operation_id`; Hmux derives private launch authority and
/// the deterministic target from it. The provider cwd remains process context
/// so local adapters do not need a second path authority on the wire.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StandaloneCreateOperationWire {
    schema_version: u16,
    operation_id: String,
    session_name: String,
    command: Vec<String>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default)]
    mode: StandaloneCreateOperationMode,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StandaloneCreateOperationMode {
    #[default]
    Create,
    ReconcileCompletedTarget,
    RetireCompletedTarget,
    AcknowledgeRetiredTarget,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", try_from = "StandaloneCreateOperationWire")]
pub struct StandaloneCreateOperationRequest {
    schema_version: u16,
    operation_id: String,
    session_name: String,
    command: Vec<String>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(
        default,
        skip_serializing_if = "StandaloneCreateOperationMode::is_create"
    )]
    mode: StandaloneCreateOperationMode,
}

impl StandaloneCreateOperationRequest {
    pub fn new(
        operation_id: impl Into<String>,
        session_name: impl Into<String>,
        command: Vec<String>,
        initial_rows: u16,
        initial_columns: u16,
    ) -> Result<Self, RuntimeContractError> {
        Self::try_from(StandaloneCreateOperationWire {
            schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            session_name: session_name.into(),
            command,
            initial_rows,
            initial_columns,
            mode: StandaloneCreateOperationMode::Create,
        })
    }

    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    #[must_use]
    pub fn session_name(&self) -> &str {
        &self.session_name
    }

    /// Select behavior outside the immutable launch binding. Non-create modes
    /// can only inspect, retire, or acknowledge this operation's exact target.
    #[must_use]
    pub fn with_mode(mut self, mode: StandaloneCreateOperationMode) -> Self {
        self.mode = mode;
        self
    }

    #[must_use]
    pub fn mode(&self) -> StandaloneCreateOperationMode {
        self.mode
    }

    /// Admit the wire request once into its stable journal binding. Launch
    /// shape is carried separately so a deterministic refusal can still bind
    /// and settle the caller-owned operation identity.
    pub fn admit(
        self,
        provider_cwd: impl Into<PathBuf>,
    ) -> Result<AdmittedStandaloneCreateOperation, RuntimeContractError> {
        let provider_cwd = provider_cwd.into();
        let target_session_id = format!("standalone_{}", self.operation_id);
        let standalone_request = StandaloneCreateRequest::new(
            provider_cwd.clone(),
            Some(self.session_name.clone()),
            self.command.clone(),
            self.initial_rows,
            self.initial_columns,
        );
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct JournalBinding<'a> {
            schema_version: u16,
            operation_id: &'a str,
            provider_cwd: &'a Path,
            session_name: &'a str,
            command: &'a [String],
            initial_rows: u16,
            initial_columns: u16,
        }
        let canonical_payload = serde_json::to_string(&JournalBinding {
            schema_version: self.schema_version,
            operation_id: &self.operation_id,
            provider_cwd: &provider_cwd,
            session_name: &self.session_name,
            command: &self.command,
            initial_rows: self.initial_rows,
            initial_columns: self.initial_columns,
        })
        .map_err(|_| RuntimeContractError::new("standalone create operation is invalid"))?;
        Ok(AdmittedStandaloneCreateOperation {
            target_session_id,
            operation_id: self.operation_id,
            canonical_payload,
            standalone_request,
        })
    }

    fn validate_envelope(&self) -> Result<(), RuntimeContractError> {
        if self.schema_version != STANDALONE_CREATE_OPERATION_SCHEMA_VERSION {
            return Err(RuntimeContractError::new(
                "standalone create operation identity is invalid",
            ));
        }
        validate_operation_id(&self.operation_id)
    }
}

impl TryFrom<StandaloneCreateOperationWire> for StandaloneCreateOperationRequest {
    type Error = RuntimeContractError;

    fn try_from(wire: StandaloneCreateOperationWire) -> Result<Self, Self::Error> {
        let request = Self {
            schema_version: wire.schema_version,
            operation_id: wire.operation_id,
            session_name: wire.session_name,
            command: wire.command,
            initial_rows: wire.initial_rows,
            initial_columns: wire.initial_columns,
            mode: wire.mode,
        };
        request.validate_envelope()?;
        Ok(request)
    }
}

impl StandaloneCreateOperationMode {
    fn is_create(&self) -> bool {
        *self == Self::Create
    }
}

/// Boundary-normalized standalone operation safe for journal and launch use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmittedStandaloneCreateOperation {
    operation_id: String,
    canonical_payload: String,
    target_session_id: String,
    standalone_request: Result<StandaloneCreateRequest, RuntimeContractError>,
}

impl AdmittedStandaloneCreateOperation {
    #[must_use]
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    #[must_use]
    pub fn canonical_payload(&self) -> &str {
        &self.canonical_payload
    }

    #[must_use]
    pub fn target_session_id(&self) -> &str {
        &self.target_session_id
    }

    pub fn standalone_request(&self) -> Result<&StandaloneCreateRequest, &RuntimeContractError> {
        self.standalone_request.as_ref()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StandaloneCreateOperationResponse {
    Created {
        schema_version: u16,
        operation_id: String,
        session_name: String,
        session_id: String,
        workspace_id: String,
    },
    Retired {
        schema_version: u16,
        operation_id: String,
        session_name: String,
        session_id: String,
        workspace_id: String,
    },
    Acknowledged {
        schema_version: u16,
        operation_id: String,
    },
    Refused {
        schema_version: u16,
        operation_id: String,
        error_code: String,
    },
    Pending {
        schema_version: u16,
        operation_id: String,
        error_code: String,
    },
}

impl StandaloneCreateOperationResponse {
    #[must_use]
    pub fn created(operation_id: impl Into<String>, receipt: &StandaloneCreateReceipt) -> Self {
        Self::Created {
            schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            session_name: receipt.session_name().to_string(),
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
        }
    }

    #[must_use]
    pub fn retired(operation_id: impl Into<String>, receipt: &StandaloneCreateReceipt) -> Self {
        Self::Retired {
            schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            session_name: receipt.session_name().to_string(),
            session_id: receipt.session_id().to_string(),
            workspace_id: receipt.workspace_id().to_string(),
        }
    }

    #[must_use]
    pub fn acknowledged(operation_id: impl Into<String>) -> Self {
        Self::Acknowledged {
            schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
            operation_id: operation_id.into(),
        }
    }

    #[must_use]
    pub fn refused(operation_id: impl Into<String>, error_code: impl Into<String>) -> Self {
        Self::Refused {
            schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            error_code: error_code.into(),
        }
    }

    #[must_use]
    pub fn pending(operation_id: impl Into<String>, error_code: impl Into<String>) -> Self {
        Self::Pending {
            schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
            operation_id: operation_id.into(),
            error_code: error_code.into(),
        }
    }

    pub fn validate(&self) -> Result<(), RuntimeContractError> {
        let (schema_version, operation_id) = match self {
            Self::Created {
                schema_version,
                operation_id,
                session_name,
                session_id,
                workspace_id,
            }
            | Self::Retired {
                schema_version,
                operation_id,
                session_name,
                session_id,
                workspace_id,
            } => {
                validate_identifier(session_name, "standalone operation session name")?;
                validate_identifier(session_id, "standalone operation session id")?;
                validate_identifier(workspace_id, "standalone operation workspace id")?;
                if session_id != &format!("standalone_{operation_id}") {
                    return Err(RuntimeContractError::new(
                        "standalone operation target identity is invalid",
                    ));
                }
                (schema_version, operation_id)
            }
            Self::Refused {
                schema_version,
                operation_id,
                error_code,
            }
            | Self::Pending {
                schema_version,
                operation_id,
                error_code,
            } => {
                validate_opaque_identity(error_code, "standalone operation error code")?;
                if !error_code.starts_with("hmux_") {
                    return Err(RuntimeContractError::new(
                        "standalone operation error code is invalid",
                    ));
                }
                (schema_version, operation_id)
            }
            Self::Acknowledged {
                schema_version,
                operation_id,
            } => (schema_version, operation_id),
        };
        if *schema_version != STANDALONE_CREATE_OPERATION_SCHEMA_VERSION {
            return Err(RuntimeContractError::new(
                "standalone operation response schema is invalid",
            ));
        }
        validate_operation_id(operation_id)
    }

    pub fn validate_against(
        &self,
        request: &StandaloneCreateOperationRequest,
    ) -> Result<(), RuntimeContractError> {
        self.validate()?;
        let mode_allows_outcome = match request.mode() {
            StandaloneCreateOperationMode::Create => {
                !matches!(self, Self::Retired { .. } | Self::Acknowledged { .. })
            }
            StandaloneCreateOperationMode::ReconcileCompletedTarget => {
                !matches!(self, Self::Acknowledged { .. })
            }
            StandaloneCreateOperationMode::RetireCompletedTarget => {
                matches!(
                    self,
                    Self::Retired { .. } | Self::Pending { .. } | Self::Refused { .. }
                )
            }
            StandaloneCreateOperationMode::AcknowledgeRetiredTarget => {
                !matches!(self, Self::Created { .. } | Self::Retired { .. })
            }
        };
        if !mode_allows_outcome {
            return Err(RuntimeContractError::new(
                "standalone operation response does not match the request mode",
            ));
        }
        let (operation_id, session_name) = match self {
            Self::Created {
                operation_id,
                session_name,
                ..
            }
            | Self::Retired {
                operation_id,
                session_name,
                ..
            } => (operation_id, Some(session_name.as_str())),
            Self::Refused { operation_id, .. } | Self::Pending { operation_id, .. } => {
                (operation_id, None)
            }
            Self::Acknowledged { operation_id, .. } => (operation_id, None),
        };
        if operation_id != request.operation_id()
            || session_name.is_some_and(|name| name != request.session_name())
        {
            return Err(RuntimeContractError::new(
                "standalone operation response does not match the request",
            ));
        }
        Ok(())
    }
}

fn validate_operation_id(operation_id: &str) -> Result<(), RuntimeContractError> {
    if operation_id.len() != 64
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(RuntimeContractError::new(
            "standalone create operation identity is invalid",
        ));
    }
    Ok(())
}

pub fn read_standalone_create_operation_response(
    reader: &mut impl Read,
) -> Result<StandaloneCreateOperationResponse, RuntimeContractError> {
    let response: StandaloneCreateOperationResponse = read_json_frame(reader)?;
    response.validate()?;
    Ok(response)
}

pub fn read_standalone_create_operation_response_for(
    reader: &mut impl Read,
    request: &StandaloneCreateOperationRequest,
) -> Result<StandaloneCreateOperationResponse, RuntimeContractError> {
    let response: StandaloneCreateOperationResponse = read_json_frame(reader)?;
    response.validate_against(request)?;
    Ok(response)
}

pub fn read_standalone_create_operation_request(
    reader: &mut impl Read,
) -> Result<StandaloneCreateOperationRequest, RuntimeContractError> {
    read_json_frame(reader)
}

pub fn write_standalone_create_operation_response(
    writer: &mut impl Write,
    response: &StandaloneCreateOperationResponse,
) -> Result<(), RuntimeContractError> {
    response.validate()?;
    write_json_frame(writer, response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MAX_BROKER_FRAME_BYTES, MAX_RECOVERY_OPERATION_PAYLOAD_BYTES};
    use std::io::Cursor;

    #[cfg(unix)]
    #[test]
    fn standalone_create_operation_admits_one_versioned_binding() {
        let operation_id = "a".repeat(64);
        let request = StandaloneCreateOperationRequest::new(
            operation_id.clone(),
            "dev",
            vec!["env".into(), "pnpm".into()],
            24,
            80,
        )
        .unwrap();
        let admitted = request.clone().admit("/tmp/work").unwrap();
        assert_eq!(
            admitted.canonical_payload(),
            format!(
                "{{\"schemaVersion\":1,\"operationId\":\"{operation_id}\",\"providerCwd\":\"/tmp/work\",\"sessionName\":\"dev\",\"command\":[\"env\",\"pnpm\"],\"initialRows\":24,\"initialColumns\":80}}"
            )
        );
        assert_eq!(
            admitted.target_session_id(),
            format!("standalone_{operation_id}")
        );
        assert_eq!(
            admitted.standalone_request().unwrap().provider_cwd(),
            Path::new("/tmp/work")
        );
        assert_ne!(
            admitted.canonical_payload(),
            request
                .clone()
                .admit("/tmp/other")
                .unwrap()
                .canonical_payload()
        );
        let reconciliation =
            request.with_mode(StandaloneCreateOperationMode::ReconcileCompletedTarget);
        assert_eq!(
            reconciliation.mode(),
            StandaloneCreateOperationMode::ReconcileCompletedTarget
        );
        assert_eq!(
            reconciliation
                .clone()
                .admit("/tmp/work")
                .unwrap()
                .canonical_payload(),
            admitted.canonical_payload()
        );
        let retirement = reconciliation
            .clone()
            .with_mode(StandaloneCreateOperationMode::RetireCompletedTarget);
        assert_eq!(
            retirement
                .clone()
                .admit("/tmp/work")
                .unwrap()
                .canonical_payload(),
            admitted.canonical_payload()
        );
        let acknowledgement =
            retirement.with_mode(StandaloneCreateOperationMode::AcknowledgeRetiredTarget);
        assert_eq!(
            acknowledgement
                .admit("/tmp/work")
                .unwrap()
                .canonical_payload(),
            admitted.canonical_payload()
        );
    }

    #[cfg(unix)]
    #[test]
    fn standalone_create_operation_rejects_invalid_boundary_input() {
        let operation_id = "b".repeat(64);
        assert!(
            StandaloneCreateOperationRequest::new("B".repeat(64), "dev", Vec::new(), 24, 80)
                .is_err()
        );
        for request in [
            StandaloneCreateOperationRequest::new(operation_id.as_str(), "", Vec::new(), 24, 80)
                .unwrap(),
            StandaloneCreateOperationRequest::new(
                operation_id.as_str(),
                "dev",
                vec![String::new()],
                24,
                80,
            )
            .unwrap(),
            StandaloneCreateOperationRequest::new(operation_id.as_str(), "dev", Vec::new(), 0, 80)
                .unwrap(),
        ] {
            assert!(
                request
                    .admit("/tmp/work")
                    .unwrap()
                    .standalone_request()
                    .is_err()
            );
        }
        assert!(
            serde_json::from_value::<StandaloneCreateOperationRequest>(serde_json::json!({
                "schemaVersion": 2,
                "operationId": operation_id,
                "sessionName": "dev",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<StandaloneCreateOperationRequest>(serde_json::json!({
                "schemaVersion": 1,
                "operationId": "c".repeat(64),
                "sessionName": "dev",
                "command": [],
                "initialRows": 24,
                "initialColumns": 80,
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn standalone_operation_leaves_durable_capacity_to_the_journal() {
        let admitted = StandaloneCreateOperationRequest::new(
            "b".repeat(64),
            "journal-authority",
            vec!["\\".repeat(4_096); 4],
            24,
            80,
        )
        .unwrap()
        .admit("/tmp/work")
        .unwrap();

        assert!(admitted.standalone_request().is_ok());
    }

    #[test]
    fn standalone_create_operation_outcomes_are_correlated_and_public() {
        let operation_id = "d".repeat(64);
        let receipt = StandaloneCreateReceipt::new(
            format!("standalone_{operation_id}"),
            "workspace-1",
            "dev",
            "/tmp/discovery",
            "private-proof",
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(StandaloneCreateOperationResponse::created(
                operation_id.as_str(),
                &receipt,
            ))
            .unwrap(),
            serde_json::json!({
                "outcome": "created",
                "schemaVersion": 1,
                "operationId": operation_id,
                "sessionName": "dev",
                "sessionId": receipt.session_id(),
                "workspaceId": "workspace-1"
            })
        );
        assert_eq!(
            serde_json::to_value(StandaloneCreateOperationResponse::refused(
                "e".repeat(64),
                "hmux_refused",
            ))
            .unwrap(),
            serde_json::json!({
                "outcome": "refused",
                "schemaVersion": 1,
                "operationId": "e".repeat(64),
                "errorCode": "hmux_refused"
            })
        );
        assert_eq!(
            serde_json::to_value(StandaloneCreateOperationResponse::retired(
                operation_id.as_str(),
                &receipt,
            ))
            .unwrap(),
            serde_json::json!({
                "outcome": "retired",
                "schemaVersion": 1,
                "operationId": operation_id,
                "sessionName": "dev",
                "sessionId": receipt.session_id(),
                "workspaceId": "workspace-1"
            })
        );
        assert_eq!(
            serde_json::to_value(StandaloneCreateOperationResponse::pending(
                "f".repeat(64),
                "hmux_standalone_recovery_target_unavailable",
            ))
            .unwrap(),
            serde_json::json!({
                "outcome": "pending",
                "schemaVersion": 1,
                "operationId": "f".repeat(64),
                "errorCode": "hmux_standalone_recovery_target_unavailable"
            })
        );
        assert_eq!(
            serde_json::to_value(StandaloneCreateOperationResponse::acknowledged(
                operation_id.as_str(),
            ))
            .unwrap(),
            serde_json::json!({
                "outcome": "acknowledged",
                "schemaVersion": 1,
                "operationId": operation_id,
            })
        );
    }

    #[test]
    fn standalone_create_operation_manifest_is_the_cross_language_wire_authority() {
        let manifest: serde_json::Value =
            serde_json::from_str(STANDALONE_CREATE_OPERATION_PROTOCOL_MANIFEST).unwrap();
        assert_eq!(
            manifest["schemaVersion"],
            STANDALONE_CREATE_OPERATION_SCHEMA_VERSION
        );
        assert_eq!(
            manifest["subcommand"],
            STANDALONE_CREATE_OPERATION_SUBCOMMAND
        );
        assert_eq!(
            manifest["capability"],
            STANDALONE_CREATE_OPERATION_CAPABILITY
        );
        assert_eq!(manifest["frameLimitBytes"], MAX_BROKER_FRAME_BYTES);
        assert_eq!(
            manifest["journalPayloadLimitBytes"],
            MAX_RECOVERY_OPERATION_PAYLOAD_BYTES
        );

        let request: StandaloneCreateOperationRequest =
            serde_json::from_value(manifest["requestExample"].clone()).unwrap();
        assert_eq!(request.operation_id(), "a".repeat(64));
        assert_eq!(request.mode(), StandaloneCreateOperationMode::Create);
        assert_eq!(
            manifest["modes"],
            serde_json::json!([
                StandaloneCreateOperationMode::Create,
                StandaloneCreateOperationMode::ReconcileCompletedTarget,
                StandaloneCreateOperationMode::RetireCompletedTarget,
                StandaloneCreateOperationMode::AcknowledgeRetiredTarget,
            ])
        );
        let reconcile_request: StandaloneCreateOperationRequest =
            serde_json::from_value(manifest["reconcileRequestExample"].clone()).unwrap();
        assert_eq!(reconcile_request.operation_id(), request.operation_id());
        assert_eq!(
            reconcile_request.mode(),
            StandaloneCreateOperationMode::ReconcileCompletedTarget
        );
        assert_eq!(
            manifest["reconcileCapability"],
            STANDALONE_CREATE_OPERATION_RECONCILE_CAPABILITY
        );
        let retire_request: StandaloneCreateOperationRequest =
            serde_json::from_value(manifest["retireRequestExample"].clone()).unwrap();
        assert_eq!(retire_request.operation_id(), request.operation_id());
        assert_eq!(
            retire_request.mode(),
            StandaloneCreateOperationMode::RetireCompletedTarget
        );
        assert_eq!(
            manifest["retireCapability"],
            STANDALONE_CREATE_OPERATION_RETIRE_COMPLETED_TARGET_CAPABILITY
        );
        let acknowledge_request: StandaloneCreateOperationRequest =
            serde_json::from_value(manifest["acknowledgeRequestExample"].clone()).unwrap();
        assert_eq!(acknowledge_request.operation_id(), request.operation_id());
        assert_eq!(
            acknowledge_request.mode(),
            StandaloneCreateOperationMode::AcknowledgeRetiredTarget
        );
        assert_eq!(
            manifest["acknowledgeCapability"],
            STANDALONE_CREATE_OPERATION_RETIREMENT_ACKNOWLEDGE_CAPABILITY
        );
        for outcome in ["created", "pending", "refused", "retired", "acknowledged"] {
            let response: StandaloneCreateOperationResponse =
                serde_json::from_value(manifest["responseExamples"][outcome].clone()).unwrap();
            response.validate().unwrap();
        }
    }

    #[test]
    fn standalone_create_operation_response_reader_rejects_invalid_states() {
        for invalid in [
            serde_json::json!({
                "outcome": "pending",
                "schemaVersion": 2,
                "operationId": "a".repeat(64),
                "errorCode": "hmux_retry"
            }),
            serde_json::json!({
                "outcome": "refused",
                "schemaVersion": 1,
                "operationId": "A".repeat(64),
                "errorCode": "hmux_refused"
            }),
            serde_json::json!({
                "outcome": "created",
                "schemaVersion": 1,
                "operationId": "a".repeat(64),
                "sessionName": "dev",
                "sessionId": "standalone_wrong",
                "workspaceId": "workspace-1"
            }),
        ] {
            let mut frame = Vec::new();
            write_json_frame(&mut frame, &invalid).unwrap();
            assert!(read_standalone_create_operation_response(&mut Cursor::new(frame)).is_err());
        }

        let request = StandaloneCreateOperationRequest::new(
            "a".repeat(64),
            "expected-name",
            vec!["true".into()],
            24,
            80,
        )
        .unwrap();
        for uncorrelated in [
            StandaloneCreateOperationResponse::pending("b".repeat(64), "hmux_retry"),
            StandaloneCreateOperationResponse::Created {
                schema_version: STANDALONE_CREATE_OPERATION_SCHEMA_VERSION,
                operation_id: "a".repeat(64),
                session_name: "another-name".into(),
                session_id: format!("standalone_{}", "a".repeat(64)),
                workspace_id: "workspace-1".into(),
            },
        ] {
            let mut frame = Vec::new();
            write_standalone_create_operation_response(&mut frame, &uncorrelated).unwrap();
            assert!(
                read_standalone_create_operation_response_for(&mut Cursor::new(frame), &request,)
                    .is_err()
            );
        }
        let receipt = StandaloneCreateReceipt::new(
            format!("standalone_{}", request.operation_id()),
            "workspace-1",
            request.session_name(),
            "/tmp/discovery",
            "private-proof",
        )
        .unwrap();
        let retired = StandaloneCreateOperationResponse::retired(request.operation_id(), &receipt);
        let mut frame = Vec::new();
        write_standalone_create_operation_response(&mut frame, &retired).unwrap();
        assert!(
            read_standalone_create_operation_response_for(
                &mut Cursor::new(frame.clone()),
                &request,
            )
            .is_err()
        );
        let reconciliation =
            request.with_mode(StandaloneCreateOperationMode::ReconcileCompletedTarget);
        assert_eq!(
            read_standalone_create_operation_response_for(
                &mut Cursor::new(frame.clone()),
                &reconciliation,
            )
            .unwrap(),
            retired,
        );
        let retirement = reconciliation
            .clone()
            .with_mode(StandaloneCreateOperationMode::RetireCompletedTarget);
        assert_eq!(
            read_standalone_create_operation_response_for(&mut Cursor::new(frame), &retirement,)
                .unwrap(),
            retired,
        );
        let acknowledged =
            StandaloneCreateOperationResponse::acknowledged(reconciliation.operation_id());
        let mut frame = Vec::new();
        write_standalone_create_operation_response(&mut frame, &acknowledged).unwrap();
        assert!(
            read_standalone_create_operation_response_for(
                &mut Cursor::new(frame.clone()),
                &reconciliation,
            )
            .is_err()
        );
        let acknowledgement =
            retirement.with_mode(StandaloneCreateOperationMode::AcknowledgeRetiredTarget);
        let mut created_frame = Vec::new();
        write_standalone_create_operation_response(
            &mut created_frame,
            &StandaloneCreateOperationResponse::created(acknowledgement.operation_id(), &receipt),
        )
        .unwrap();
        assert!(
            read_standalone_create_operation_response_for(
                &mut Cursor::new(created_frame),
                &acknowledgement,
            )
            .is_err()
        );
        assert_eq!(
            read_standalone_create_operation_response_for(
                &mut Cursor::new(frame),
                &acknowledgement,
            )
            .unwrap(),
            acknowledged,
        );
    }
}
