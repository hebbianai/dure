use super::*;

fn registration() -> GitCheckoutRegistrationV1 {
    GitCheckoutRegistrationV1 {
        repository_path: "/repo".into(),
        instance: crate::GitCheckoutInstanceV1 {
            schema_version: 1,
            canonical_path: "/repo/.worktrees/codex-1".into(),
            git_common_dir: "/repo/.git".into(),
            git_dir: "/repo/.git/worktrees/codex-1".into(),
            instance_token: format!("dwt1_{}", "a".repeat(32)),
        },
    }
}

#[test]
fn selected_checkout_journal_binds_the_claim_to_the_planned_incarnation() {
    let selected = registration();
    let mut draft = draft();
    draft.request.worktree = AgentSpawnWorktreePolicyV1::ExistingCheckout {
        instance: selected.instance.clone(),
        branch: "user/work".into(),
        base_commit_sha: "a".repeat(40),
    };
    let plan = create_agent_spawn_plan_v1(draft).unwrap();
    let mut events = completed_events(&plan)[..2].to_vec();
    events.push(event(
        &plan,
        3,
        AgentSpawnJournalEventBodyV1::CheckoutClaimed {
            registration: selected.clone(),
        },
    ));
    assert_eq!(
        fold_agent_spawn_journal_v1(&events)
            .unwrap()
            .checkout_registration,
        Some(selected.clone())
    );

    let mut replacement = selected;
    replacement.instance.instance_token = format!("dwt1_{}", "b".repeat(32));
    events[2] = event(
        &plan,
        3,
        AgentSpawnJournalEventBodyV1::CheckoutClaimed {
            registration: replacement,
        },
    );
    assert!(fold_agent_spawn_journal_v1(&events).is_err());
}

#[test]
fn checkout_evidence_is_additive_and_stable_for_legacy_and_current_journals() {
    let plan = create_agent_spawn_plan_v1(draft()).unwrap();
    let mut events = completed_events(&plan);
    let legacy = fold_agent_spawn_journal_v1(&events).unwrap();
    let encoded = serde_json::to_value(&legacy).unwrap();
    assert!(encoded.get("checkoutRegistration").is_none());
    assert_eq!(
        serde_json::from_value::<AgentSpawnJournalReceiptV1>(encoded).unwrap(),
        legacy
    );

    events.insert(
        2,
        event(
            &plan,
            3,
            AgentSpawnJournalEventBodyV1::CheckoutClaimed {
                registration: registration(),
            },
        ),
    );
    for (index, item) in events.iter_mut().enumerate().skip(3) {
        *item = event(&plan, u32::try_from(index + 1).unwrap(), item.body.clone());
    }
    let claimed = fold_agent_spawn_journal_v1(&events).unwrap();
    assert_eq!(claimed.checkout_registration, Some(registration()));
    assert_eq!(claimed.completed, legacy.completed);
    assert_eq!(claimed.recovery, legacy.recovery);
    assert_eq!(
        serde_json::from_str::<AgentSpawnJournalReceiptV1>(
            &serde_json::to_string(&claimed).unwrap()
        )
        .unwrap(),
        claimed
    );
}

#[test]
fn checkout_evidence_is_once_only_after_preparation_and_before_terminalization() {
    let plan = create_agent_spawn_plan_v1(draft()).unwrap();
    let mut events = completed_events(&plan);
    let body = AgentSpawnJournalEventBodyV1::CheckoutClaimed {
        registration: registration(),
    };
    let before_prepared = vec![events[0].clone(), event(&plan, 2, body.clone())];
    assert!(fold_agent_spawn_journal_v1(&before_prepared).is_err());

    let mut claimed = events[..2].to_vec();
    claimed.push(event(&plan, 3, body.clone()));
    assert!(fold_agent_spawn_journal_v1(&claimed).is_ok());
    claimed.push(event(&plan, 4, body.clone()));
    assert!(fold_agent_spawn_journal_v1(&claimed).is_err());

    let next = u32::try_from(events.len() + 1).unwrap();
    events.push(event(&plan, next, AgentSpawnJournalEventBodyV1::Succeeded));
    events.push(event(&plan, next + 1, body));
    assert!(fold_agent_spawn_journal_v1(&events).is_err());
}
