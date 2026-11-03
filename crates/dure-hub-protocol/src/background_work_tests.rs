use super::*;
use crate::conversation::{ConversationError, ConversationRefusal, HUB_CONVERSATION_VERSION};

fn item(id: usize, label: &str) -> HubBackgroundWorkItem {
    HubBackgroundWorkItem {
        id: format!("task-{id}"),
        kind: HubBackgroundWorkKind::Shell,
        label: Some(label.to_string()),
        started_unix_ms: 1_793_600_000_000 + id as u64,
        steps: Some(HubBackgroundWorkSteps { done: 1, total: 2 }),
        tokens: Some(4_700_000),
    }
}

#[test]
fn a_listed_answer_round_trips_through_its_frame() {
    let result = HubAgentBackgroundWorkResult::listed(
        vec![item(1, "Watch the release chain")],
        HubBackgroundWorkCounts {
            shells: 1,
            ..HubBackgroundWorkCounts::default()
        },
        false,
    );
    assert_eq!(result.hub_conversation_version, HUB_CONVERSATION_VERSION);
    assert_eq!(result.outcome, BackgroundWorkOutcome::Listed);
    let framed = encode_background_work(&result).expect("encodes");
    assert_eq!(
        read_background_work(&mut framed.as_slice()).expect("reads"),
        result
    );
}

#[test]
fn the_wire_shape_is_snake_case_and_omits_what_is_absent() {
    let mut bare = item(1, "x");
    bare.label = None;
    bare.steps = None;
    bare.tokens = None;
    let value = serde_json::to_value(HubAgentBackgroundWorkResult::listed(
        vec![bare],
        HubBackgroundWorkCounts {
            shells: 1,
            ..HubBackgroundWorkCounts::default()
        },
        false,
    ))
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "hub_conversation_version": HUB_CONVERSATION_VERSION,
            "outcome": "listed",
            "items": [{"id": "task-1", "kind": "shell", "started_unix_ms": 1_793_600_000_001u64}],
            "counts": {"subagents": 0, "workflows": 0, "shells": 1, "monitors": 0},
        })
    );
}

#[test]
fn listed_bounds_items_and_labels() {
    let items: Vec<_> = (0..70).map(|id| item(id, &"가".repeat(200))).collect();
    let result = HubAgentBackgroundWorkResult::listed(
        items,
        HubBackgroundWorkCounts {
            shells: 70,
            ..HubBackgroundWorkCounts::default()
        },
        false,
    );
    assert_eq!(result.items.len(), MAX_BACKGROUND_WORK_ITEMS);
    assert!(result.truncated);
    assert!(
        result
            .items
            .iter()
            .all(|item| item.label.as_deref().unwrap().chars().count()
                == MAX_BACKGROUND_WORK_LABEL_CHARS)
    );
    assert_eq!(result.counts.shells, 70);
}

#[test]
fn the_largest_list_fits_its_frame() {
    // The worst case JSON escaping can make of a label: control characters
    // are removed upstream, so the widest is a quote or backslash per char.
    let items: Vec<_> = (0..MAX_BACKGROUND_WORK_ITEMS)
        .map(|id| {
            let mut wide = item(id, &"\"".repeat(MAX_BACKGROUND_WORK_LABEL_CHARS));
            wide.id = "i".repeat(256);
            wide
        })
        .collect();
    let result = HubAgentBackgroundWorkResult::listed(
        items,
        HubBackgroundWorkCounts {
            shells: u32::MAX,
            ..HubBackgroundWorkCounts::default()
        },
        true,
    );
    encode_background_work(&result).expect("the largest list fits one frame");
}

#[test]
fn a_refusal_carries_its_code() {
    let result =
        HubAgentBackgroundWorkResult::refused(ConversationRefusal::SessionNotFound, "gone");
    assert_eq!(result.outcome, BackgroundWorkOutcome::Refused);
    assert!(result.items.is_empty());
    let framed = encode_background_work(&result).unwrap();
    let back = read_background_work(&mut framed.as_slice()).unwrap();
    assert_eq!(back.code, Some(ConversationRefusal::SessionNotFound));
}

#[test]
fn an_unknown_kind_reads_as_unknown() {
    let item: HubBackgroundWorkItem = serde_json::from_value(serde_json::json!({
        "id": "x", "kind": "cron", "started_unix_ms": 1
    }))
    .unwrap();
    assert_eq!(item.kind, HubBackgroundWorkKind::Unknown);
}

#[test]
fn a_newer_version_is_refused() {
    let mut value = serde_json::to_value(HubAgentBackgroundWorkResult::listed(
        Vec::new(),
        HubBackgroundWorkCounts::default(),
        false,
    ))
    .unwrap();
    value["hub_conversation_version"] = serde_json::json!(HUB_CONVERSATION_VERSION + 1);
    let framed = crate::frame::encode(&value, MAX_BACKGROUND_WORK_RESULT_BYTES).unwrap();
    assert!(matches!(
        read_background_work(&mut framed.as_slice()),
        Err(ConversationError::UnsupportedVersion { .. })
    ));
}
