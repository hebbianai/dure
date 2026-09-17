use std::{env, fs, path::PathBuf, process};

fn main() {
    let mode = env::args().nth(1).unwrap_or_else(|| "--check".to_owned());
    if mode != "--check" && mode != "--write" {
        eprintln!("usage: export-extension-contracts [--check|--write]");
        process::exit(2);
    }

    let output_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src/contracts/generated/extensionContracts.ts");
    let expected = dure_app::typescript_contracts();
    if mode == "--write" {
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).expect("create generated contract directory");
        }
        fs::write(&output_path, expected).expect("write generated TypeScript contracts");
        return;
    }

    let actual = fs::read_to_string(&output_path).unwrap_or_default();
    if actual != expected {
        eprintln!(
            "{} is stale; run `pnpm contracts:write`",
            output_path.display()
        );
        process::exit(1);
    }
}
