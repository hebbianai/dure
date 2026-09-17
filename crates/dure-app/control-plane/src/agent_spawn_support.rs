use std::fmt::Write as _;

use dure_app::DomainStoreErrorV1;

pub(super) fn random_nonce() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "agent_spawn_entropy_unavailable".to_string())?;
    let mut nonce = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut nonce, "{byte:02x}")
            .map_err(|_| "agent_spawn_entropy_unavailable".to_string())?;
    }
    Ok(nonce)
}

pub(super) fn store_error(error: DomainStoreErrorV1) -> String {
    match error {
        DomainStoreErrorV1::IdempotencyConflict { .. } => "agent_spawn_idempotency_conflict".into(),
        DomainStoreErrorV1::AgentSpawnPlanAdmissionRejected { code } => code.into(),
        DomainStoreErrorV1::Storage {
            code: "corrupt_provider_launch_defaults",
            ..
        } => "agent_spawn_provider_defaults_malformed".into(),
        DomainStoreErrorV1::Busy { .. } => "agent_spawn_store_busy".into(),
        _ => "agent_spawn_store_failed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_provider_defaults_remain_a_typed_spawn_failure() {
        assert_eq!(
            store_error(DomainStoreErrorV1::Storage {
                code: "corrupt_provider_launch_defaults",
                detail: "fixture corruption".into(),
            }),
            "agent_spawn_provider_defaults_malformed"
        );
    }
}
