use super::super::{RecoveryCompletion, STANDALONE_CREATE_OPERATION_RECOVERY_ACTION};

const PREFIX: &str = "failed_";
const INVALID_OPERATION: &str = "hmux_standalone_create_operation_invalid";

#[cfg(test)]
mod tests;

/// Preserve the existing standalone operation's terminal wire representation.
pub fn completion(target_session_id: &str, namespace: &str, code: &str) -> RecoveryCompletion {
    RecoveryCompletion {
        target_session_id: target_session_id.into(),
        target_workspace_id: namespace.into(),
        target_build_id: "not_created".into(),
        action: STANDALONE_CREATE_OPERATION_RECOVERY_ACTION.into(),
        outcome: format!("{PREFIX}{code}"),
        resume_checkpoint: None,
        operation_checkpoint: None,
    }
}

/// Parse the terminal outcome once; a completion for another target, a partial
/// legacy failure, or a simultaneous success receipt is not this refusal.
pub fn code<'a>(
    completion: &'a RecoveryCompletion,
    target_session_id: &str,
    namespace: &str,
) -> Result<Option<&'a str>, String> {
    let Some(code) = completion.outcome.strip_prefix(PREFIX) else {
        return Ok(None);
    };
    if completion.action != STANDALONE_CREATE_OPERATION_RECOVERY_ACTION
        || !code.starts_with("hmux_")
        || completion.target_session_id != target_session_id
        || completion.target_workspace_id != namespace
        || completion.target_build_id != "not_created"
        || completion
            .operation_checkpoint
            .as_ref()
            .is_some_and(|checkpoint| checkpoint.replacement_receipt.is_some())
        || (completion.operation_checkpoint.is_none() && code != INVALID_OPERATION)
    {
        return Err("hmux_standalone_create_operation_invalid".into());
    }
    Ok(Some(code))
}
