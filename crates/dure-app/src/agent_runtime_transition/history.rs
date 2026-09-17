use super::*;

pub(super) fn validate(record: &AgentRuntimeTransitionRecordV1) -> Result<(), DomainStoreErrorV1> {
    let successor = record.predecessor_operation_id.is_some();
    let wake_revision = i64::from(matches!(
        record.deferred_target,
        Some(AgentRuntimeDeferredTargetV1::Requested { .. })
    ));
    // Native Resume publishes its already-ready successor in one CAS. The
    // dormant journal records no target attempt, wake grant or invented failure.
    let dormant_successor =
        record.state == AgentRuntimeTransitionStateV1::Superseded && record.target_is_deferred();
    let minimum_revision = match record.state {
        AgentRuntimeTransitionStateV1::Admitted => 1,
        AgentRuntimeTransitionStateV1::SourceRetained => 2,
        AgentRuntimeTransitionStateV1::SourceStopped => {
            if successor {
                1
            } else {
                2
            }
        }
        AgentRuntimeTransitionStateV1::RepairRequired
        | AgentRuntimeTransitionStateV1::TargetStarted => {
            if successor {
                2
            } else {
                3
            }
        }
        AgentRuntimeTransitionStateV1::Superseded if dormant_successor => 3,
        AgentRuntimeTransitionStateV1::Committed | AgentRuntimeTransitionStateV1::Superseded => {
            if successor {
                3
            } else {
                4
            }
        }
    };
    let lifecycle_revision = record.journal_revision - wake_revision;
    if lifecycle_revision < minimum_revision
        || (record.state == AgentRuntimeTransitionStateV1::Admitted && record.journal_revision != 1)
        || (record.state == AgentRuntimeTransitionStateV1::SourceRetained
            && record.journal_revision != 2)
    {
        return Err(invalid(
            "journalRevision",
            "does not match the transition history",
        ));
    }
    let revision_parity_is_valid = match record.state {
        AgentRuntimeTransitionStateV1::Admitted | AgentRuntimeTransitionStateV1::SourceRetained => {
            true
        }
        AgentRuntimeTransitionStateV1::Superseded if dormant_successor => {
            lifecycle_revision % 2 == 1
        }
        AgentRuntimeTransitionStateV1::SourceStopped
        | AgentRuntimeTransitionStateV1::Committed
        | AgentRuntimeTransitionStateV1::Superseded => {
            lifecycle_revision % 2 == i64::from(successor)
        }
        AgentRuntimeTransitionStateV1::RepairRequired
        | AgentRuntimeTransitionStateV1::TargetStarted => {
            lifecycle_revision % 2 != i64::from(successor)
        }
    };
    if !revision_parity_is_valid {
        return Err(invalid(
            "journalRevision",
            "does not match the transition history parity",
        ));
    }
    let repaired_history = lifecycle_revision > minimum_revision;
    if repaired_history != record.last_repair_operation_id.is_some() {
        return Err(invalid(
            "lastRepairOperationId",
            "presence does not match the transition repair history",
        ));
    }
    Ok(())
}
