use std::collections::BTreeMap;

use dure_app::{
    PluginSettingDefinitionV1, PluginSettingKeyV1, PluginSettingScopeV1, PluginSettingValueV1,
    PluginSettingsSchemaV1,
};

fn schema() -> PluginSettingsSchemaV1 {
    serde_json::from_str(include_str!(
        "../../../plugins/beads/contributions/settings.json"
    ))
    .expect("bundled Beads settings must deserialize")
}

#[test]
fn bundled_beads_settings_are_valid_and_scope_defaults() {
    let schema = schema();
    schema.validate().unwrap();

    let user = schema.defaults(PluginSettingScopeV1::User);
    assert_eq!(
        user.get(&PluginSettingKeyV1::new("notifications").unwrap()),
        Some(&PluginSettingValueV1::Boolean(true))
    );
    let workspace = schema.defaults(PluginSettingScopeV1::Workspace);
    assert_eq!(
        workspace.get(&PluginSettingKeyV1::new("watch_interval_seconds").unwrap()),
        Some(&PluginSettingValueV1::Integer(30))
    );
}

#[test]
fn settings_reject_unknown_wrong_scope_and_out_of_range_values() {
    let schema = schema();
    let cases = [
        (
            PluginSettingScopeV1::User,
            "unknown",
            PluginSettingValueV1::Boolean(true),
        ),
        (
            PluginSettingScopeV1::User,
            "watch_interval_seconds",
            PluginSettingValueV1::Integer(30),
        ),
        (
            PluginSettingScopeV1::Workspace,
            "watch_interval_seconds",
            PluginSettingValueV1::Integer(2),
        ),
    ];
    for (scope, key, value) in cases {
        let values = BTreeMap::from([(PluginSettingKeyV1::new(key).unwrap(), value)]);
        assert!(schema.validate_values(scope, &values).is_err());
    }
}

#[test]
fn choice_defaults_must_be_declared_options() {
    let mut schema = schema();
    let choice = schema
        .settings
        .iter_mut()
        .find(|definition| {
            matches!(
                definition,
                PluginSettingDefinitionV1::Choice { key, .. }
                    if key.as_str() == "default_view"
            )
        })
        .expect("default view choice exists");
    let PluginSettingDefinitionV1::Choice { default, .. } = choice else {
        unreachable!()
    };
    *default = "missing".to_owned();
    assert!(schema.validate().is_err());
}
