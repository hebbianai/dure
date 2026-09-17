use std::fs;
use std::path::{Path, PathBuf};

const MODULES: &[&str] = &["contract", "domain", "ports", "service"];

const FORBIDDEN_SOURCE_REFERENCES: &[&str] = &[
    "dure::", "dure_", "tauri::", "hmux::", "hmux_", "beads::", "beads_", "codex::", "codex_",
    "claude::", "claude_",
];

const FORBIDDEN_MANIFEST_REFERENCES: &[&str] = &[
    "dure-app", "tauri", "hmux-", "beads", "codex", "claude", "sqlx",
];

#[test]
fn scaffold_exposes_each_owned_boundary() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = fs::read_to_string(root.join("src/lib.rs")).expect("read src/lib.rs");

    for module in MODULES {
        assert!(
            root.join(format!("src/{module}.rs")).is_file()
                || root.join(format!("src/{module}/mod.rs")).is_file(),
            "missing src/{module}.rs or src/{module}/mod.rs"
        );
        assert!(
            library.contains(&format!("pub mod {module};")),
            "src/lib.rs must expose {module}"
        );
    }
}

#[test]
fn source_root_stays_limited_to_the_four_owned_buckets() {
    let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");

    for entry in fs::read_dir(&source_root).expect("read source root") {
        let path = entry.expect("read source entry").path();
        let name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .expect("UTF-8 source entry");
        assert!(
            name == "lib" || MODULES.contains(&name),
            "unexpected top-level source bucket {}; nest it under an owned module",
            path.display()
        );
    }
}

#[test]
fn product_and_adapter_imports_stay_outside_the_core() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut sources = Vec::new();
    collect_rust_sources(&root.join("src"), &mut sources);

    for source in sources {
        let body = fs::read_to_string(&source).expect("read Rust source");
        for forbidden in FORBIDDEN_SOURCE_REFERENCES {
            assert!(
                !body.contains(forbidden),
                "{} contains forbidden product or adapter reference {forbidden}",
                source.display()
            );
        }
    }

    let manifest = fs::read_to_string(root.join("Cargo.toml")).expect("read Cargo.toml");
    for forbidden in FORBIDDEN_MANIFEST_REFERENCES {
        assert!(
            !manifest.contains(forbidden),
            "Cargo.toml contains forbidden product or adapter dependency {forbidden}"
        );
    }
}

#[test]
fn domain_contract_and_service_do_not_know_storage_or_delivery_carriers() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let forbidden = [
        "sqlite",
        "sqlx",
        "rowid",
        "std::path",
        "filesystem",
        "ssh::",
        "hmux",
        "terminal::",
        "codex",
        "claude",
        "localhost",
    ];
    for module in ["domain.rs", "contract.rs", "service.rs"] {
        let body = fs::read_to_string(root.join("src").join(module))
            .expect("read core source")
            .to_ascii_lowercase();
        for carrier in forbidden {
            assert!(
                !body.contains(carrier),
                "{module} contains concrete storage/delivery carrier {carrier}"
            );
        }
    }
}

#[test]
fn store_mutation_trait_is_the_only_public_adapter_implementation_boundary() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let ports = fs::read_to_string(root.join("src/ports/mod.rs")).expect("read ports module");
    assert!(ports.contains("pub trait Store"));
    assert!(ports.contains("pub struct StoreHandle"));
}

fn collect_rust_sources(directory: &Path, sources: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read source directory") {
        let path = entry.expect("read source entry").path();
        if path.is_dir() {
            collect_rust_sources(&path, sources);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            sources.push(path);
        }
    }
}
