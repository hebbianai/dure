//! Generate the UI projection from accepted adapter plans, never a second list.
use std::{collections::BTreeMap, env, fs, path::PathBuf};

use dure_app::{ProviderIdV1, ProviderPermissionModeV1};
use dure_provider_adapter::{
    NativeProviderConversationReference, native_provider_launch_plan, reviewed_native_provider_ids,
};

fn projection() -> String {
    let providers = reviewed_native_provider_ids()
        .map(|id| {
            let provider = ProviderIdV1::new(id).expect("reviewed provider ID");
            let modes = [
                ProviderPermissionModeV1::Default,
                ProviderPermissionModeV1::AutoEdit,
                ProviderPermissionModeV1::SkipPermissions,
            ]
            .into_iter()
            .filter(|mode| {
                native_provider_launch_plan(
                    &provider,
                    mode,
                    None,
                    None,
                    NativeProviderConversationReference::Fresh,
                )
                .is_ok_and(|plan| plan.is_some())
            })
            .collect::<Vec<_>>();
            (id, modes)
        })
        .collect::<BTreeMap<_, _>>();
    format!(
        "{}\n",
        serde_json::to_string_pretty(&providers).expect("serialize modes")
    )
}

fn output_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../src/contracts/generated/providerPermissionModes.json")
}

fn main() {
    match env::args().nth(1).as_deref() {
        Some("--write") => fs::write(output_path(), projection()).expect("write permission modes"),
        None | Some("--check") => assert_eq!(
            fs::read_to_string(output_path()).unwrap_or_default(),
            projection(),
            "Permission projection is stale; run cargo run --manifest-path crates/dure-app/Cargo.toml -p dure-provider-adapter --bin export_permission_modes -- --write"
        ),
        _ => panic!("usage: export_permission_modes [--check|--write]"),
    }
}

#[test]
fn frontend_modes_match_the_plans_accepted_by_the_execution_adapter() {
    assert_eq!(
        fs::read_to_string(output_path()).unwrap_or_default(),
        projection()
    );
}
