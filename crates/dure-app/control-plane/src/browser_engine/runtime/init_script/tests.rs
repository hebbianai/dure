use super::*;

fn registration() -> Registration {
    Registration {
        resource: BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("resource:a").unwrap(),
            generation: BrowserResourceGeneration::new("generation:1").unwrap(),
            workspace_id: BrowserWorkspaceId::new("workspace:a").unwrap(),
        },
        page_id: BrowserPageId::new("page:1").unwrap(),
        instance: BrowserInstanceId::new("instance:1").unwrap(),
        target: BrowserTargetId::new("target:1").unwrap(),
        session: "session:1".into(),
        native_id: "1".into(),
    }
}

#[test]
fn init_script_handles_require_a_complete_bounded_versioned_scope() {
    let value = registration().encode().unwrap();
    let decoded = BrowserInitScriptIdentifier::try_from(value.clone()).unwrap();
    assert_eq!(decoded.0.encode().unwrap(), value);
    for invalid in [
        "1".into(),
        value.replace("init:v1:", "init:v2:"),
        format!("{value}="),
        format!("init:v1:{}", "a".repeat(MAX_IDENTIFIER)),
    ] {
        assert!(BrowserInitScriptIdentifier::try_from(invalid).is_err());
    }
    let complete = serde_json::to_value(registration()).unwrap();
    for key in [
        "resource",
        "page_id",
        "instance",
        "target",
        "session",
        "native_id",
    ] {
        let mut missing = complete.clone();
        missing.as_object_mut().unwrap().remove(key);
        let value = format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&missing).unwrap())
        );
        assert!(
            BrowserInitScriptIdentifier::try_from(value).is_err(),
            "{key}"
        );
    }
    for (key, value) in [
        ("session", "".to_owned()),
        ("native_id", "x".repeat(161)),
        ("native_id", "a\0b".to_owned()),
        ("unexpected", "extra".to_owned()),
    ] {
        let mut invalid = complete.clone();
        invalid[key] = value.into();
        let value = format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invalid).unwrap())
        );
        assert!(BrowserInitScriptIdentifier::try_from(value).is_err());
    }
}

#[test]
fn init_script_actions_bound_source_without_running_it_immediately() {
    for script in [
        "".to_owned(),
        "window.label='한글'".to_owned(),
        "a".repeat(64 * 1024),
    ] {
        let action: BrowserAction = serde_json::from_value(
            json!({"kind":"init_script","action":{"kind":"add","script":script}}),
        )
        .unwrap();
        assert!(action.init_script().is_some());
        assert!(!action.uses_document());
        assert!(!action.replaces_elements());
    }
    for action in [
        json!({"kind":"add","script":"한".repeat(21846)}),
        json!({"kind":"add"}),
        json!({"kind":"add","script":"","runImmediately":true}),
        json!({"kind":"remove","identifier":"1"}),
    ] {
        assert!(
            serde_json::from_value::<BrowserAction>(json!({"kind":"init_script","action":action}))
                .is_err()
        );
    }
}
