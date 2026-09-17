use hmux_client::recovery_journal::prepared_standalone_create::execution as prepared_execution;
use hmux_client::recovery_journal::{
    PendingRecoverySource, RECOVERY_COMPLETION_ACKNOWLEDGED_CODE,
    RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE, RecoveryCompletion, RecoveryCompletionAcknowledgement,
    RecoveryCompletionLookup, RecoveryIdentity, RecoveryReservation, RecoveryReservationState,
    SAVED_RECIPE_RECOVERY_NAMESPACE, STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME,
    STANDALONE_CREATE_OPERATION_RECOVERY_ACTION, acknowledge_completion,
    acknowledge_completion_releasing_source, prepared_standalone_create, read_completed_existing,
    request_fingerprint, reserve,
};
use hmux_client::{
    COMPLETED_STANDALONE_TARGET_SCHEMA as COMPLETED_TARGET_SCHEMA, ClientError,
    CompletedStandaloneTarget as CompletedTargetCheckpoint, CompletedStandaloneTargetLifecycle,
    LocalSessionCatalog, StandaloneCreateReceipt, StandaloneCreateRequest,
    StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity, StandaloneSessionCreator,
    validate_standalone_recovery_receipt as validate_receipt,
};
use hmux_host::local_discovery::DiscoveryRoot;
use hmux_runtime_contract::{
    STANDALONE_CREATE_OPERATION_CAPABILITY, STANDALONE_CREATE_OPERATION_RECONCILE_CAPABILITY,
    STANDALONE_CREATE_OPERATION_RETIRE_COMPLETED_TARGET_CAPABILITY,
    STANDALONE_CREATE_OPERATION_RETIREMENT_ACKNOWLEDGE_CAPABILITY, StandaloneCreateOperationMode,
    StandaloneCreateOperationRequest, StandaloneCreateOperationResponse,
    read_standalone_create_operation_request, write_standalone_create_operation_response,
};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

pub(crate) const CAPABILITY: &str = STANDALONE_CREATE_OPERATION_CAPABILITY;
pub(crate) const RECONCILE_CAPABILITY: &str = STANDALONE_CREATE_OPERATION_RECONCILE_CAPABILITY;
pub(crate) const RETIRE_CAPABILITY: &str =
    STANDALONE_CREATE_OPERATION_RETIRE_COMPLETED_TARGET_CAPABILITY;
pub(crate) const ACKNOWLEDGE_CAPABILITY: &str =
    STANDALONE_CREATE_OPERATION_RETIREMENT_ACKNOWLEDGE_CAPABILITY;
const ACTION: &str = STANDALONE_CREATE_OPERATION_RECOVERY_ACTION;
const RECOVERY_NAMESPACE: &str = "standalone_create_operation_v1";
const RECONCILIATION_PENDING: &str = "hmux_standalone_create_operation_reconciliation_pending";
const OPERATION_NOT_SUBMITTED: &str = "hmux_standalone_create_operation_not_submitted";
const RUNTIME_UNAVAILABLE: &str = "hmux_standalone_create_runtime_unavailable";

enum SavedCompletedTarget {
    Exact(Box<CompletedTargetCheckpoint>),
    Legacy(StandaloneCreateReceipt),
}

impl SavedCompletedTarget {
    fn receipt(&self) -> &StandaloneCreateReceipt {
        match self {
            Self::Exact(target) => target.receipt(),
            Self::Legacy(receipt) => receipt,
        }
    }
}

enum OperationFailure {
    Pending(String),
    Refused(String),
}

impl OperationFailure {
    fn code(message: impl AsRef<str>) -> String {
        let message = message.as_ref();
        let code = message
            .split_once(':')
            .map_or(message, |(code, _)| code)
            .trim();
        if code.starts_with("hmux_") {
            code.to_string()
        } else {
            "hmux_standalone_create_operation_failed".to_string()
        }
    }

    fn pending(message: impl AsRef<str>) -> Self {
        Self::Pending(Self::code(message))
    }

    fn journal(message: impl AsRef<str>) -> Self {
        let code = Self::code(message);
        if matches!(
            code.as_str(),
            "hmux_recovery_idempotency_conflict" | RECOVERY_COMPLETION_ACKNOWLEDGED_CODE
        ) {
            Self::Refused(code)
        } else {
            Self::Pending(code)
        }
    }

    fn refused(code: impl Into<String>) -> Self {
        Self::Refused(code.into())
    }

    fn invalid_request() -> Self {
        Self::refused("hmux_standalone_create_operation_invalid")
    }

    fn corrupt_state() -> Self {
        Self::pending("hmux_standalone_create_operation_invalid")
    }

    fn as_code(&self) -> &str {
        match self {
            Self::Pending(code) | Self::Refused(code) => code,
        }
    }

    fn into_response(self, operation_id: impl Into<String>) -> StandaloneCreateOperationResponse {
        match self {
            Self::Pending(code) => StandaloneCreateOperationResponse::pending(operation_id, code),
            Self::Refused(code) => StandaloneCreateOperationResponse::refused(operation_id, code),
        }
    }
}

impl From<ClientError> for OperationFailure {
    fn from(error: ClientError) -> Self {
        Self::pending(error.code())
    }
}

pub(crate) fn serve(
    catalog: &LocalSessionCatalog,
    mut input: impl Read,
    mut output: impl Write,
) -> Result<(), Box<dyn std::error::Error>> {
    let request = read_standalone_create_operation_request(&mut input)?;
    let operation_id = request.operation_id().to_string();
    let response = match execute(catalog, request, || {
        super::resolve_runtime_executable(None)
            .map_err(|_| OperationFailure::pending(RUNTIME_UNAVAILABLE))
    }) {
        Ok(response) => response,
        Err(failure) => failure.into_response(operation_id),
    };
    write_standalone_create_operation_response(&mut output, &response)?;
    Ok(())
}

fn execute(
    catalog: &LocalSessionCatalog,
    input: StandaloneCreateOperationRequest,
    resolve_runtime: impl FnOnce() -> Result<PathBuf, OperationFailure>,
) -> Result<StandaloneCreateOperationResponse, OperationFailure> {
    let mode = input.mode();
    let cwd = std::env::current_dir()
        .and_then(|path| path.canonicalize())
        .map_err(|_| OperationFailure::pending("hmux_standalone_create_cwd_unavailable"))?;
    if !cwd.is_dir() {
        return Err(OperationFailure::pending(
            "hmux_standalone_create_cwd_unavailable",
        ));
    }
    let admitted = input.admit(cwd).map_err(|_| {
        OperationFailure::pending("hmux_standalone_create_operation_binding_unavailable")
    })?;
    let public_request = admitted.standalone_request().cloned();
    let public_payload = admitted.canonical_payload().to_string();
    let operation_id = admitted.operation_id().to_string();
    let identity = RecoveryIdentity {
        recovery_id: format!("{RECOVERY_NAMESPACE}_{operation_id}"),
        source_session_id: format!("operation_{operation_id}"),
        source_workspace_id: RECOVERY_NAMESPACE.to_string(),
        request_fingerprint: request_fingerprint(&[&public_payload]),
        action: ACTION,
    };
    if mode == StandaloneCreateOperationMode::AcknowledgeRetiredTarget {
        return acknowledge_retired_target(
            catalog,
            &operation_id,
            public_request.as_ref().ok(),
            admitted.target_session_id(),
            &identity,
        );
    }
    if mode == StandaloneCreateOperationMode::RetireCompletedTarget {
        return retire_completed_target(
            catalog,
            &operation_id,
            public_request.as_ref().ok(),
            admitted.target_session_id(),
            &identity,
        );
    }
    DiscoveryRoot::create(catalog.discovery_root())
        .map_err(|error| OperationFailure::pending(error.to_string()))?;
    match reserve(catalog.discovery_root(), identity).map_err(OperationFailure::journal)? {
        RecoveryReservationState::Completed(completion) => completed_response(
            catalog,
            &operation_id,
            public_request.as_ref().ok(),
            admitted.target_session_id(),
            &completion,
            mode,
        ),
        RecoveryReservationState::Pending(mut reservation) => {
            let target_session_id = admitted.target_session_id().to_string();
            let public_request = match public_request {
                Ok(request) => request,
                Err(_) => {
                    return settle_invalid_request(
                        &mut reservation,
                        &operation_id,
                        &target_session_id,
                    );
                }
            };
            let prepared_request = if reservation.operation_checkpoint().is_none() {
                let recovery_identity = match StandaloneRecoveryCreateIdentity::new(
                    target_session_id.clone(),
                    Uuid::new_v4().to_string(),
                ) {
                    Ok(identity) => {
                        identity.with_recipe_requirement(StandaloneRecipeRequirement::RequestBound)
                    }
                    Err(_) => {
                        return settle_invalid_request(
                            &mut reservation,
                            &operation_id,
                            &target_session_id,
                        );
                    }
                };
                let request = match public_request
                    .clone()
                    .with_recovery_identity(recovery_identity)
                {
                    Ok(request) => request,
                    Err(_) => {
                        return settle_invalid_request(
                            &mut reservation,
                            &operation_id,
                            &target_session_id,
                        );
                    }
                };
                let completion_capacity = match completion_capacity(catalog, &request) {
                    Ok(capacity) => capacity,
                    Err(_) => {
                        return settle_invalid_request(
                            &mut reservation,
                            &operation_id,
                            &target_session_id,
                        );
                    }
                };
                match prepared_standalone_create::PreparedStandaloneCreate::new(request) {
                    Ok(prepared) => Some(
                        prepared
                            .with_completion_capacity(completion_capacity.0, completion_capacity.1),
                    ),
                    Err(_) => {
                        return settle_invalid_request(
                            &mut reservation,
                            &operation_id,
                            &target_session_id,
                        );
                    }
                }
            } else {
                None
            };
            let request =
                match prepared_standalone_create::load_or_prepare(&mut reservation, || {
                    Ok(prepared_request.expect("new standalone operation has no prepared request"))
                }) {
                    Ok(request) => request,
                    Err(error) if error == RECOVERY_RECORD_CAPACITY_EXCEEDED_CODE => {
                        return settle_invalid_request(
                            &mut reservation,
                            &operation_id,
                            &target_session_id,
                        );
                    }
                    Err(error) => return Err(OperationFailure::pending(error)),
                };
            validate_prepared_request(&request, &public_request, &target_session_id)?;

            let completion = if let Some(source) = reservation
                .operation_checkpoint()
                .and_then(|checkpoint| checkpoint.replacement_receipt.as_deref())
            {
                let target =
                    CompletedTargetCheckpoint::from_recovery_checkpoint(catalog, &request, source)?;
                let completion = prepared_execution::completion(&target);
                prepared_execution::complete(&mut reservation, completion)
                    .map_err(OperationFailure::pending)?
            } else {
                let runtime = resolve_runtime()?;
                let creator = StandaloneSessionCreator::new(runtime)
                    .with_discovery_root(catalog.discovery_root());
                match prepared_execution::launch(catalog, &creator, &mut reservation, request) {
                    Ok((_, completion)) => completion,
                    Err(prepared_execution::LaunchError::Runtime(error))
                        if error.is_standalone_recovery_terminal_refusal() =>
                    {
                        return Ok(StandaloneCreateOperationResponse::refused(
                            operation_id.as_str(),
                            error.code(),
                        ));
                    }
                    Err(prepared_execution::LaunchError::Runtime(error)) => {
                        return Err(OperationFailure::from(error));
                    }
                    Err(prepared_execution::LaunchError::Journal(error)) => {
                        return Err(OperationFailure::pending(error));
                    }
                }
            };
            completed_response(
                catalog,
                &operation_id,
                Some(&public_request),
                &target_session_id,
                &completion,
                mode,
            )
        }
    }
}

fn acknowledge_retired_target(
    catalog: &LocalSessionCatalog,
    operation_id: &str,
    public_request: Option<&StandaloneCreateRequest>,
    target_session_id: &str,
    identity: &RecoveryIdentity,
) -> Result<StandaloneCreateOperationResponse, OperationFailure> {
    let completion = match read_completed_existing(catalog.discovery_root(), identity)
        .map_err(OperationFailure::journal)?
    {
        RecoveryCompletionLookup::Completed(completion) => completion,
        RecoveryCompletionLookup::Acknowledged => {
            return Ok(StandaloneCreateOperationResponse::acknowledged(
                operation_id,
            ));
        }
        RecoveryCompletionLookup::Absent => {
            return Ok(StandaloneCreateOperationResponse::pending(
                operation_id,
                OPERATION_NOT_SUBMITTED,
            ));
        }
    };
    match completed_response(
        catalog,
        operation_id,
        public_request,
        target_session_id,
        &completion,
        StandaloneCreateOperationMode::ReconcileCompletedTarget,
    )? {
        StandaloneCreateOperationResponse::Retired { .. } => {}
        StandaloneCreateOperationResponse::Created { .. } => {
            return Ok(StandaloneCreateOperationResponse::pending(
                operation_id,
                RECONCILIATION_PENDING,
            ));
        }
        response @ StandaloneCreateOperationResponse::Pending { .. } => return Ok(response),
        StandaloneCreateOperationResponse::Refused { .. } => {}
        StandaloneCreateOperationResponse::Acknowledged { .. } => {
            return Err(OperationFailure::corrupt_state());
        }
    }
    let recipe_source = public_request
        .and_then(StandaloneCreateRequest::session_name)
        .map(|session_name| PendingRecoverySource {
            workspace_id: SAVED_RECIPE_RECOVERY_NAMESPACE.to_string(),
            session_id: session_name.to_string(),
        });
    let acknowledgement = if let Some(source) = recipe_source.as_ref() {
        acknowledge_completion_releasing_source(
            catalog.discovery_root(),
            identity,
            &completion,
            source,
        )
    } else {
        acknowledge_completion(catalog.discovery_root(), identity, &completion)
    }
    .map_err(OperationFailure::journal)?;
    match acknowledgement {
        RecoveryCompletionAcknowledgement::Acknowledged
        | RecoveryCompletionAcknowledgement::AlreadyAcknowledged => Ok(
            StandaloneCreateOperationResponse::acknowledged(operation_id),
        ),
        RecoveryCompletionAcknowledgement::Absent => Ok(
            StandaloneCreateOperationResponse::pending(operation_id, OPERATION_NOT_SUBMITTED),
        ),
    }
}

fn retire_completed_target(
    catalog: &LocalSessionCatalog,
    operation_id: &str,
    public_request: Option<&StandaloneCreateRequest>,
    target_session_id: &str,
    identity: &RecoveryIdentity,
) -> Result<StandaloneCreateOperationResponse, OperationFailure> {
    let completion = match read_completed_existing(catalog.discovery_root(), identity)
        .map_err(OperationFailure::journal)?
    {
        RecoveryCompletionLookup::Completed(completion) => completion,
        RecoveryCompletionLookup::Acknowledged => {
            return Ok(StandaloneCreateOperationResponse::refused(
                operation_id,
                RECOVERY_COMPLETION_ACKNOWLEDGED_CODE,
            ));
        }
        RecoveryCompletionLookup::Absent => {
            return Ok(StandaloneCreateOperationResponse::pending(
                operation_id,
                OPERATION_NOT_SUBMITTED,
            ));
        }
    };
    let reconciled = completed_response(
        catalog,
        operation_id,
        public_request,
        target_session_id,
        &completion,
        StandaloneCreateOperationMode::ReconcileCompletedTarget,
    )?;
    let (receipt, generation, provider_process) = match reconciled {
        StandaloneCreateOperationResponse::Retired { .. } => return Ok(reconciled),
        StandaloneCreateOperationResponse::Created { .. } => {
            let target = decode_exact_target(&completion)?;
            let receipt = target.receipt().clone();
            let generation = target.generation().clone();
            let provider_process = target.provider_process().clone();
            (receipt, generation, provider_process)
        }
        response @ (StandaloneCreateOperationResponse::Pending { .. }
        | StandaloneCreateOperationResponse::Refused { .. }) => return Ok(response),
        StandaloneCreateOperationResponse::Acknowledged { .. } => {
            return Err(OperationFailure::corrupt_state());
        }
    };
    Ok(
        match catalog.retire_completed_standalone_target(
            &generation,
            &provider_process,
            Duration::from_secs(1),
        ) {
            CompletedStandaloneTargetLifecycle::Retired => {
                StandaloneCreateOperationResponse::retired(operation_id, &receipt)
            }
            CompletedStandaloneTargetLifecycle::Active
            | CompletedStandaloneTargetLifecycle::Unresolved => {
                StandaloneCreateOperationResponse::pending(operation_id, RECONCILIATION_PENDING)
            }
        },
    )
}

fn decode_exact_target(
    completion: &RecoveryCompletion,
) -> Result<Box<CompletedTargetCheckpoint>, OperationFailure> {
    let checkpoint = completion
        .operation_checkpoint
        .as_ref()
        .ok_or_else(OperationFailure::corrupt_state)?;
    match decode_completed_target(
        checkpoint
            .replacement_receipt
            .as_deref()
            .ok_or_else(OperationFailure::corrupt_state)?,
    )
    .map_err(OperationFailure::pending)?
    {
        SavedCompletedTarget::Exact(target) => Ok(target),
        SavedCompletedTarget::Legacy(_) => Err(OperationFailure::pending(RECONCILIATION_PENDING)),
    }
}

fn settle_invalid_request(
    reservation: &mut RecoveryReservation,
    operation_id: &str,
    target_session_id: &str,
) -> Result<StandaloneCreateOperationResponse, OperationFailure> {
    let failure = OperationFailure::invalid_request();
    reservation
        .complete(terminal_completion(target_session_id, &failure))
        .map_err(OperationFailure::pending)?;
    Ok(StandaloneCreateOperationResponse::refused(
        operation_id,
        failure.as_code(),
    ))
}

fn validate_prepared_request(
    request: &StandaloneCreateRequest,
    public_request: &StandaloneCreateRequest,
    target_session_id: &str,
) -> Result<(), OperationFailure> {
    let recovery = request
        .recovery_identity()
        .ok_or_else(OperationFailure::corrupt_state)?;
    if request.clone().without_recovery_identity() != *public_request
        || recovery.target_session_id() != target_session_id
        || recovery.recipe_requirement() != StandaloneRecipeRequirement::RequestBound
    {
        return Err(OperationFailure::corrupt_state());
    }
    Ok(())
}

fn terminal_completion(target_session_id: &str, failure: &OperationFailure) -> RecoveryCompletion {
    prepared_standalone_create::refusal::completion(
        target_session_id,
        RECOVERY_NAMESPACE,
        failure.as_code(),
    )
}

fn completion_capacity(
    catalog: &LocalSessionCatalog,
    request: &StandaloneCreateRequest,
) -> Result<(RecoveryCompletion, String), OperationFailure> {
    let target = CompletedTargetCheckpoint::capacity_witness(catalog, request)?;
    let completion = prepared_execution::completion(&target);
    let receipt = serde_json::to_string(&target).map_err(|_| OperationFailure::corrupt_state())?;
    Ok((completion, receipt))
}

fn completed_response(
    catalog: &LocalSessionCatalog,
    operation_id: &str,
    public_request: Option<&StandaloneCreateRequest>,
    target_session_id: &str,
    completion: &RecoveryCompletion,
    mode: StandaloneCreateOperationMode,
) -> Result<StandaloneCreateOperationResponse, OperationFailure> {
    if completion.action != ACTION {
        return Err(OperationFailure::corrupt_state());
    }
    let terminal_code = prepared_standalone_create::refusal::code(
        completion,
        target_session_id,
        RECOVERY_NAMESPACE,
    )
    .map_err(OperationFailure::pending)?;
    if let Some(error_code) = terminal_code {
        if completion.operation_checkpoint.is_none() {
            return Ok(StandaloneCreateOperationResponse::refused(
                operation_id,
                error_code,
            ));
        }
    }
    let checkpoint = completion
        .operation_checkpoint
        .as_ref()
        .ok_or_else(OperationFailure::corrupt_state)?;
    let request: StandaloneCreateRequest = serde_json::from_str(&checkpoint.canonical_payload)
        .map_err(|_| OperationFailure::corrupt_state())?;
    request
        .validate()
        .map_err(|_| OperationFailure::corrupt_state())?;
    validate_prepared_request(
        &request,
        public_request.ok_or_else(OperationFailure::corrupt_state)?,
        target_session_id,
    )?;
    if let Some(error_code) = terminal_code {
        return Ok(StandaloneCreateOperationResponse::refused(
            operation_id,
            error_code,
        ));
    }
    if completion.outcome != STANDALONE_CREATE_OPERATION_COMPLETION_OUTCOME {
        return Err(OperationFailure::corrupt_state());
    }
    let target = decode_completed_target(
        checkpoint
            .replacement_receipt
            .as_deref()
            .ok_or_else(OperationFailure::corrupt_state)?,
    )
    .map_err(OperationFailure::pending)?;
    let receipt = target.receipt();
    validate_receipt(catalog, &request, receipt)?;
    if completion.target_session_id != receipt.session_id()
        || completion.target_workspace_id != receipt.workspace_id()
        || completion.target_build_id.is_empty()
    {
        return Err(OperationFailure::corrupt_state());
    }
    if mode == StandaloneCreateOperationMode::ReconcileCompletedTarget {
        let SavedCompletedTarget::Exact(target) = &target else {
            return Ok(StandaloneCreateOperationResponse::pending(
                operation_id,
                RECONCILIATION_PENDING,
            ));
        };
        if target.host_build_version() != completion.target_build_id {
            return Err(OperationFailure::corrupt_state());
        }
        let lifecycle = catalog
            .resolve_completed_standalone_target(target.generation(), target.provider_process());
        return Ok(match lifecycle {
            CompletedStandaloneTargetLifecycle::Active => {
                StandaloneCreateOperationResponse::created(operation_id, receipt)
            }
            CompletedStandaloneTargetLifecycle::Retired => {
                StandaloneCreateOperationResponse::retired(operation_id, receipt)
            }
            CompletedStandaloneTargetLifecycle::Unresolved => {
                StandaloneCreateOperationResponse::pending(operation_id, RECONCILIATION_PENDING)
            }
        });
    }
    Ok(StandaloneCreateOperationResponse::created(
        operation_id,
        receipt,
    ))
}

fn decode_completed_target(source: &str) -> Result<SavedCompletedTarget, String> {
    let value: serde_json::Value = serde_json::from_str(source)
        .map_err(|_| "hmux_standalone_create_operation_invalid: saved target is malformed")?;
    if value.get("schema").and_then(serde_json::Value::as_str) == Some(COMPLETED_TARGET_SCHEMA) {
        let target: CompletedTargetCheckpoint = serde_json::from_value(value)
            .map_err(|_| "hmux_standalone_create_operation_invalid: saved target is malformed")?;
        return Ok(SavedCompletedTarget::Exact(Box::new(target)));
    }
    let receipt: StandaloneCreateReceipt = serde_json::from_value(value)
        .map_err(|_| "hmux_standalone_create_operation_invalid: saved receipt is malformed")?;
    receipt
        .validate()
        .map_err(|_| "hmux_standalone_create_operation_invalid: saved receipt is invalid")?;
    Ok(SavedCompletedTarget::Legacy(receipt))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation_id: char) -> StandaloneCreateOperationRequest {
        StandaloneCreateOperationRequest::new(
            operation_id.to_string().repeat(64),
            format!("runtime-resolution-{operation_id}"),
            vec!["provider-fixture".to_string()],
            24,
            80,
        )
        .unwrap()
    }

    #[test]
    fn acknowledgement_does_not_resolve_the_runtime_or_create_storage() {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("absent-discovery");
        let catalog = LocalSessionCatalog::new(&discovery_root);
        let input = request('a').with_mode(StandaloneCreateOperationMode::AcknowledgeRetiredTarget);

        let response = execute(&catalog, input, || panic!("runtime resolution was reached"));
        assert!(matches!(
            response,
            Ok(StandaloneCreateOperationResponse::Pending { error_code, .. })
                if error_code == OPERATION_NOT_SUBMITTED
        ));
        assert!(!discovery_root.exists());
    }

    #[test]
    fn retirement_does_not_resolve_the_runtime_or_create_storage() {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("absent-discovery");
        let catalog = LocalSessionCatalog::new(&discovery_root);
        let input = request('d').with_mode(StandaloneCreateOperationMode::RetireCompletedTarget);

        let response = execute(&catalog, input, || panic!("runtime resolution was reached"));
        assert!(matches!(
            response,
            Ok(StandaloneCreateOperationResponse::Pending { error_code, .. })
                if error_code == OPERATION_NOT_SUBMITTED
        ));
        assert!(!discovery_root.exists());
    }

    #[test]
    fn completed_replay_does_not_resolve_the_runtime() {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        DiscoveryRoot::create(&discovery_root).unwrap();
        let catalog = LocalSessionCatalog::new(&discovery_root);
        let input = request('b');
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let admitted = input.clone().admit(cwd).unwrap();
        let public_payload = admitted.canonical_payload().to_string();
        let identity = RecoveryIdentity {
            recovery_id: format!("{RECOVERY_NAMESPACE}_{}", input.operation_id()),
            source_session_id: format!("operation_{}", input.operation_id()),
            source_workspace_id: RECOVERY_NAMESPACE.to_string(),
            request_fingerprint: request_fingerprint(&[&public_payload]),
            action: ACTION,
        };
        let RecoveryReservationState::Pending(mut reservation) =
            reserve(&discovery_root, identity).unwrap()
        else {
            panic!("new test operation unexpectedly completed")
        };
        reservation
            .complete(terminal_completion(
                admitted.target_session_id(),
                &OperationFailure::invalid_request(),
            ))
            .unwrap();
        drop(reservation);

        let response = execute(&catalog, input, || panic!("runtime resolution was reached"));
        assert!(matches!(
            response,
            Ok(StandaloneCreateOperationResponse::Refused { error_code, .. })
                if error_code == "hmux_standalone_create_operation_invalid"
        ));
    }

    #[test]
    fn new_create_reports_pending_when_the_runtime_is_unavailable() {
        let state = tempfile::tempdir().unwrap();
        let catalog = LocalSessionCatalog::new(state.path().join("discovery"));
        let input = request('c');
        let operation_id = input.operation_id().to_string();

        let failure = match execute(&catalog, input, || {
            Err(OperationFailure::pending(RUNTIME_UNAVAILABLE))
        }) {
            Ok(response) => panic!("new create unexpectedly completed: {response:?}"),
            Err(failure) => failure,
        };
        assert!(matches!(
            failure.into_response(operation_id),
            StandaloneCreateOperationResponse::Pending { error_code, .. }
                if error_code == RUNTIME_UNAVAILABLE
        ));
    }
}
