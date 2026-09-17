use dure_app::{
    ISSUE_TRACKER_QUERY_LIMIT_V2, IssueTrackerAgentTaskContextV2, IssueTrackerCapabilityIdV2,
    IssueTrackerCommonOperationV2, IssueTrackerIssueIdV1, IssueTrackerLifecycleV2,
    IssueTrackerProviderV2, IssueTrackerQueryResultV2, IssueTrackerQueryV2,
    IssueTrackerTaskDetailV2, IssueTrackerTaskRefV2,
};

fn beads_provider() -> IssueTrackerProviderV2 {
    serde_json::from_str(include_str!("fixtures/issue-tracker-beads-v2.json"))
        .expect("Beads V2 provider fixture must deserialize")
}

fn github_provider() -> IssueTrackerProviderV2 {
    serde_json::from_str(include_str!("fixtures/issue-tracker-github-v2.json"))
        .expect("GitHub V2 provider fixture must deserialize")
}

#[test]
fn beads_and_github_share_only_common_read_operations() {
    let beads = beads_provider();
    let github = github_provider();
    beads.validate().unwrap();
    github.validate().unwrap();

    for provider in [&beads, &github] {
        assert!(provider.supports(IssueTrackerCommonOperationV2::List));
        assert!(provider.supports(IssueTrackerCommonOperationV2::Show));
    }
    assert!(beads.supports(IssueTrackerCommonOperationV2::Watch));
    assert!(!beads.supports(IssueTrackerCommonOperationV2::Search));
    assert!(github.supports(IssueTrackerCommonOperationV2::Search));
    assert!(!github.supports(IssueTrackerCommonOperationV2::Watch));

    assert!(beads.has_capability(&IssueTrackerCapabilityIdV2::new("beads.issue.ready").unwrap()));
    assert!(!github.has_capability(&IssueTrackerCapabilityIdV2::new("beads.issue.ready").unwrap()));
}

#[test]
fn provider_features_fail_closed_on_duplicates_or_foreign_namespaces() {
    let mut provider = github_provider();
    provider
        .provider_capabilities
        .push(IssueTrackerCapabilityIdV2::new("github.issue.labels").unwrap());
    assert!(provider.validate().is_err());

    let mut provider = github_provider();
    provider.provider_capabilities =
        vec![IssueTrackerCapabilityIdV2::new("beads.issue.ready").unwrap()];
    assert!(provider.validate().is_err());

    let mut provider = github_provider();
    provider.common_operations = vec![IssueTrackerCommonOperationV2::Search];
    assert!(provider.validate().is_err());
}

#[test]
fn task_references_preserve_opaque_ids_display_keys_and_exact_provider_status() {
    let detail: IssueTrackerTaskDetailV2 = serde_json::from_value(serde_json::json!({
        "summary": {
            "task_ref": {
                "source": {
                    "provider": "github",
                    "connection_id": "github.personal",
                    "scope_id": "hebbianai/dure-internal",
                    "scope_display_name": "hebbianai/dure-internal"
                },
                "task_id": "I_kwDOABCD1234",
                "display_key": "#123",
                "web_url": "https://github.com/hebbianai/dure-internal/issues/123"
            },
            "title": "Support external task trackers",
            "lifecycle": "open",
            "provider_status": {
                "id": "open",
                "name": "Open"
            },
            "assignees": [
                { "id": "MDQ6VXNlcjE=", "name": "octocat" }
            ],
            "labels": [
                { "id": "LA_kwDOABCD", "name": "integration" }
            ],
            "updated_at": "2026-08-03T07:00:00Z"
        },
        "description": "The provider remains the source of truth."
    }))
    .unwrap();

    github_provider().validate_task_detail(&detail).unwrap();
    assert_eq!(detail.summary.lifecycle, IssueTrackerLifecycleV2::Open);
    assert_eq!(detail.summary.task_ref.task_id.as_str(), "I_kwDOABCD1234");
    assert_eq!(detail.summary.task_ref.display_key.as_str(), "#123");
    assert_eq!(detail.summary.provider_status.name, "Open");

    assert!(IssueTrackerIssueIdV1::new("#123").is_err());
    assert!(IssueTrackerIssueIdV1::new("ENG-42").is_err());
}

#[test]
fn query_and_result_validation_rejects_unbounded_provider_data() {
    let source = serde_json::json!({
        "provider": "github",
        "connection_id": "github.personal",
        "scope_id": "hebbianai/dure-internal",
        "scope_display_name": "hebbianai/dure-internal"
    });
    let query: IssueTrackerQueryV2 = serde_json::from_value(serde_json::json!({
        "kind": "list",
        "source": source,
        "limit": ISSUE_TRACKER_QUERY_LIMIT_V2
    }))
    .unwrap();
    github_provider().validate_query(&query).unwrap();
    assert_eq!(query.operation(), IssueTrackerCommonOperationV2::List);

    let invalid_query: IssueTrackerQueryV2 = serde_json::from_value(serde_json::json!({
        "kind": "search",
        "source": {
            "provider": "github",
            "connection_id": "github.personal",
            "scope_id": "hebbianai/dure-internal",
            "scope_display_name": "hebbianai/dure-internal"
        },
        "query": "unsafe\nquery",
        "limit": 10
    }))
    .unwrap();
    assert!(invalid_query.validate().is_err());

    let beads_search: IssueTrackerQueryV2 = serde_json::from_value(serde_json::json!({
        "kind": "search",
        "source": {
            "provider": "beads",
            "connection_id": "beads.workspace",
            "scope_id": "/workspace/dure",
            "scope_display_name": "dure"
        },
        "query": "tracker",
        "limit": 10
    }))
    .unwrap();
    assert!(beads_search.validate().is_ok());
    assert!(beads_provider().validate_query(&beads_search).is_err());

    let result = IssueTrackerQueryResultV2::TaskList {
        tasks: Vec::new(),
        complete: true,
    };
    result.validate().unwrap();
}

#[test]
fn task_links_and_provider_identity_fail_closed_before_rendering() {
    let provider = github_provider();
    let mut task_ref: IssueTrackerTaskRefV2 = serde_json::from_value(serde_json::json!({
        "source": {
            "provider": "github",
            "connection_id": "github.personal",
            "scope_id": "hebbianai/dure-internal",
            "scope_display_name": "hebbianai/dure-internal"
        },
        "task_id": "123",
        "display_key": "#123",
        "web_url": "https://github.com/hebbianai/dure-internal/issues/123"
    }))
    .unwrap();
    provider.validate_task_ref(&task_ref).unwrap();

    task_ref.web_url = Some("https://".to_owned());
    assert!(provider.validate_task_ref(&task_ref).is_err());

    task_ref.web_url = None;
    task_ref.source.provider = dure_app::ProviderIdV1::new("linear").unwrap();
    assert!(provider.validate_task_ref(&task_ref).is_err());
}

#[test]
fn agent_context_identifies_one_provider_task_without_mirroring_authority() {
    let context: IssueTrackerAgentTaskContextV2 = serde_json::from_value(serde_json::json!({
        "schema_version": 2,
        "binding": {
            "kind": "scm_branch",
            "branch": "agent/codex-24"
        },
        "snapshot": {
            "summary": {
                "task_ref": {
                    "source": {
                        "provider": "beads",
                        "connection_id": "beads.workspace",
                        "scope_id": "/workspace/dure",
                        "scope_display_name": "dure"
                    },
                    "task_id": "hebbian-frontend-x7qk",
                    "display_key": "hebbian-frontend-x7qk",
                    "web_url": null
                },
                "title": "Provider-neutral issue tracker V2 contract",
                "lifecycle": "open",
                "provider_status": {
                    "id": "in_progress",
                    "name": "In progress"
                },
                "assignees": [],
                "labels": [],
                "updated_at": "2026-08-03T08:05:54Z"
            },
            "description": "Expose one bounded task snapshot to the Agent pane."
        },
        "observed_at": "2026-08-03T08:20:00Z"
    }))
    .unwrap();

    beads_provider()
        .validate_agent_task_context(&context)
        .unwrap();
    assert_eq!(
        context.snapshot.summary.task_ref.task_id.as_str(),
        "hebbian-frontend-x7qk"
    );
    assert!(
        github_provider()
            .validate_agent_task_context(&context)
            .is_err()
    );
}

#[test]
fn agent_context_rejects_invalid_binding_and_oversized_prompt_content() {
    let context: IssueTrackerAgentTaskContextV2 = serde_json::from_value(serde_json::json!({
        "schema_version": 2,
        "binding": { "kind": "scm_branch", "branch": "agent/unsafe\nbranch" },
        "snapshot": {
            "summary": {
                "task_ref": {
                    "source": {
                        "provider": "github",
                        "connection_id": "github.personal",
                        "scope_id": "hebbianai/dure-internal",
                        "scope_display_name": "hebbianai/dure-internal"
                    },
                    "task_id": "123",
                    "display_key": "#123",
                    "web_url": null
                },
                "title": "Unsafe context",
                "lifecycle": "open",
                "provider_status": { "id": "open", "name": "Open" },
                "assignees": [],
                "labels": [],
                "updated_at": null
            },
            "description": null
        },
        "observed_at": "2026-08-03T08:20:00Z"
    }))
    .unwrap();
    assert!(context.validate().is_err());

    let mut oversized = context;
    oversized.binding = dure_app::IssueTrackerAgentTaskBindingV2::Explicit;
    oversized.snapshot.description = Some("x".repeat(32_769));
    assert!(oversized.validate().is_err());
}

fn sample_task() -> IssueTrackerTaskDetailV2 {
    serde_json::from_value(serde_json::json!({
        "summary": {
            "task_ref": {
                "source": {
                    "provider": "github", "connection_id": "github.personal",
                    "scope_id": "repo/one", "scope_display_name": "Repository one"
                },
                "task_id": "I_opaque", "display_key": "#210", "web_url": null
            },
            "title": "Fixture", "lifecycle": "unknown",
            "provider_status": { "id": "triage/review", "name": "Under review" },
            "assignees": [], "labels": [], "updated_at": null
        },
        "description": null
    }))
    .unwrap()
}

#[test]
fn invalid_provider_declarations_cannot_validate_otherwise_valid_tasks() {
    let task = sample_task();
    github_provider().validate_task_detail(&task).unwrap();
    let mut provider = github_provider();
    provider
        .common_operations
        .push(IssueTrackerCommonOperationV2::List);
    assert!(provider.validate_task_detail(&task).is_err());
    assert!(provider.validate_task_ref(&task.summary.task_ref).is_err());
    assert!(
        provider
            .validate_source(&task.summary.task_ref.source)
            .is_err()
    );
}

#[test]
fn both_production_v1_descriptors_remain_compatible() {
    for source in [
        include_str!("../../../plugins/beads/contributions/issue-tracker.json"),
        include_str!("../../../plugins/github/contributions/issue-tracker.json"),
    ] {
        let provider: dure_app::IssueTrackerProviderV1 = serde_json::from_str(source).unwrap();
        provider.validate().unwrap();
        let round_trip: dure_app::IssueTrackerProviderV1 =
            serde_json::from_value(serde_json::to_value(&provider).unwrap()).unwrap();
        assert_eq!(round_trip, provider);
    }
}

#[test]
fn malformed_wire_capabilities_fail_closed() {
    for (field, value) in [
        ("schema_version", serde_json::json!(1)),
        ("authority", serde_json::json!("host")),
        (
            "common_operations",
            serde_json::json!(["list", "show", "human"]),
        ),
        (
            "common_operations",
            serde_json::json!(["list", "show", "list"]),
        ),
        (
            "provider_capabilities",
            serde_json::json!(["github.issue.labels", "github.issue.labels"]),
        ),
        (
            "provider_capabilities",
            serde_json::json!(["github.issue.unsafe\ncapability"]),
        ),
    ] {
        let mut value_to_parse = serde_json::to_value(github_provider()).unwrap();
        value_to_parse[field] = value;
        let accepted = serde_json::from_value::<IssueTrackerProviderV2>(value_to_parse)
            .is_ok_and(|provider| provider.validate().is_ok());
        assert!(!accepted, "invalid {field} must fail before adapter work");
    }
}

#[test]
fn bounded_results_preserve_incomplete_observation_and_exact_unknown_status() {
    let task = sample_task();
    let mut result = IssueTrackerQueryResultV2::TaskList {
        tasks: vec![task.summary; usize::from(ISSUE_TRACKER_QUERY_LIMIT_V2)],
        complete: false,
    };
    result.validate().unwrap();
    let round_trip: IssueTrackerQueryResultV2 =
        serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
    assert_eq!(round_trip, result);
    let IssueTrackerQueryResultV2::TaskList { tasks, complete } = &mut result else {
        panic!("expected task list");
    };
    assert!(!*complete);
    assert_eq!(tasks[0].lifecycle, IssueTrackerLifecycleV2::Unknown);
    assert_eq!(tasks[0].provider_status.id.as_str(), "triage/review");
    tasks.push(tasks[0].clone());
    assert!(result.validate().is_err());
}
