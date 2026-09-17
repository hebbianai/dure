use std::{collections::BTreeMap, fs, path::Path, sync::Arc};

use dure_app::PluginResourcePathV2;

// Compile the production package image without starting a desktop application.
#[path = "../../../src-tauri/src/plugin_bundled_package/slack.rs"]
mod slack;

fn owned(bytes: &'static [u8]) -> Arc<[u8]> {
    Arc::from(bytes)
}

fn resource_path(value: &str) -> PluginResourcePathV2 {
    PluginResourcePathV2::new(value).unwrap()
}

fn collect(root: &Path, directory: &Path, files: &mut BTreeMap<String, Vec<u8>>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect(root, &path, files);
        } else {
            files.insert(
                format!(
                    "./{}",
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                ),
                fs::read(path).unwrap(),
            );
        }
    }
}

#[test]
fn slack_native_integrations_ship_the_complete_declared_package() {
    let snapshot = slack::snapshot().unwrap();
    let files = snapshot
        .embedded_authority()
        .unwrap()
        .package_files()
        .map(|(path, bytes)| (path.as_str().to_owned(), bytes.to_vec()))
        .collect::<BTreeMap<_, _>>();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/slack");
    let mut repository_files = BTreeMap::new();
    collect(&root, &root, &mut repository_files);
    assert_eq!(files, repository_files);
}
