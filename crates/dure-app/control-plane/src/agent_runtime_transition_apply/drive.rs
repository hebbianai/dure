use super::*;

pub(crate) async fn drive_locked(
    state: &ServiceState,
    mut transition: AgentRuntimeTransitionRecordV1,
) -> Result<TransitionDriveOutcome, String> {
    let agent_id = transition.intent.source.agent_id.clone();
    let mut prepared_profile = None;

    loop {
        transition = match transition.state {
            AgentRuntimeTransitionStateV1::Admitted => {
                prepared_profile = Some(
                    state
                        .credential_profiles
                        .prepare_for_launch(
                            &transition.intent.source.provider_id,
                            &transition.intent.target_execution_profile,
                        )
                        .await
                        .map_err(|error| error.code().to_string())?,
                );
                match stop_source(state, &transition).await {
                    Ok(stopped) => stopped,
                    Err(SourceStopFailure::SourceRetained) => {
                        advance(
                            state,
                            &transition,
                            AgentRuntimeTransitionAdvanceV1::SourceRetained,
                        )
                        .await?;
                        return Ok(TransitionDriveOutcome::SourceRetained);
                    }
                    Err(SourceStopFailure::Failed(error)) => return Err(error),
                }
            }
            AgentRuntimeTransitionStateV1::SourceRetained => {
                return Ok(TransitionDriveOutcome::SourceRetained);
            }
            AgentRuntimeTransitionStateV1::SourceStopped => {
                if !transition.permits_target_effects() {
                    return Ok(TransitionDriveOutcome::Deferred);
                }
                let prepared_profile = match prepared_profile.take() {
                    Some(prepared) => Ok(prepared),
                    None => {
                        state
                            .credential_profiles
                            .prepare_for_launch(
                                &transition.intent.source.provider_id,
                                &transition.intent.target_execution_profile,
                            )
                            .await
                    }
                };
                let target = match prepared_profile {
                    Ok(prepared) => start_target(state, &transition, prepared).await,
                    Err(error) => Err(credential_failure(error)),
                };
                match target {
                    Ok(started) => started,
                    Err(TargetStartFailure::RepairRequired {
                        failure,
                        replacement_authority,
                    }) => {
                        advance(
                            state,
                            &transition,
                            AgentRuntimeTransitionAdvanceV1::RepairRequired {
                                failure: failure.clone(),
                                replacement_authority: replacement_authority.clone(),
                            },
                        )
                        .await?;
                        return Ok(TransitionDriveOutcome::RepairRequired);
                    }
                    Err(TargetStartFailure::Retryable(error)) => return Err(error),
                }
            }
            AgentRuntimeTransitionStateV1::RepairRequired => {
                transition
                    .target_failure
                    .as_ref()
                    .ok_or_else(|| "agent_runtime_transition_store_failed".to_string())?;
                return Ok(TransitionDriveOutcome::RepairRequired);
            }
            AgentRuntimeTransitionStateV1::TargetStarted => {
                advance(
                    state,
                    &transition,
                    AgentRuntimeTransitionAdvanceV1::Committed,
                )
                .await?
            }
            AgentRuntimeTransitionStateV1::Committed => {
                let selection = state
                    .store
                    .agent_runtime_selection(&agent_id)
                    .await
                    .map_err(store_error)?
                    .ok_or_else(|| "agent_runtime_selection_unavailable".to_string())?;
                let expected = transition
                    .intent
                    .target_selection_at(transition.updated_at_ms)
                    .map_err(store_error)?;
                if selection != expected {
                    return Err("agent_runtime_transition_commit_stale".into());
                }
                let authority = transition
                    .target_authority
                    .as_ref()
                    .ok_or_else(|| "agent_runtime_transition_commit_stale".to_string())?;
                return transition_receipt(&selection, authority, Some(&transition))
                    .map(Box::new)
                    .map(TransitionDriveOutcome::Committed);
            }
            AgentRuntimeTransitionStateV1::Superseded => {
                return Ok(TransitionDriveOutcome::Superseded);
            }
        };
    }
}

fn credential_failure(error: ProviderCredentialProfileErrorV1) -> TargetStartFailure {
    let kind = match error {
        ProviderCredentialProfileErrorV1::StaleGeneration => {
            AgentRuntimeTargetFailureKindV1::CredentialStale
        }
        ProviderCredentialProfileErrorV1::RequestInvalid
        | ProviderCredentialProfileErrorV1::Unavailable
        | ProviderCredentialProfileErrorV1::Conflict => {
            AgentRuntimeTargetFailureKindV1::CredentialUnavailable
        }
        ProviderCredentialProfileErrorV1::StoreFailed => {
            return TargetStartFailure::retryable(error.code());
        }
    };
    TargetStartFailure::repair(kind, error.code())
}
