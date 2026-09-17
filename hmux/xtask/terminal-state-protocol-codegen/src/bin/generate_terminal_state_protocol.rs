use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let hmux_dir = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .ok_or("codegen xtask must remain directly below hmux/xtask")?;
    let protocol_dir = hmux_dir.join("crates/terminal-state-protocol");
    let schema_dir = protocol_dir.join("schema");
    let schema_relative = [
        "terminal/state/common/v1/common.proto",
        "terminal/state/history/v1/history.proto",
        "terminal/state/model/v1/model.proto",
        "terminal/state/events/v1/events.proto",
        "terminal/state/input/v1/input.proto",
        "terminal/state/projection/v1/projection.proto",
        "terminal/state/envelope/v1/envelope.proto",
    ];
    let schemas: Vec<_> = schema_relative
        .iter()
        .map(|relative| schema_dir.join(relative))
        .collect();
    let out_dir = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| protocol_dir.join("src"));
    let generated_dir = out_dir.join("generated");
    if generated_dir.exists() {
        fs::remove_dir_all(&generated_dir)?;
    }
    fs::create_dir_all(&generated_dir)?;

    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.out_dir(&generated_dir);
    config.boxed(".terminal.state.envelope.v1.TerminalStateRecord.body.snapshot");
    // Terminal payloads can contain stdin, paste, clipboard, title, URI, and
    // screen text. Generated messages must never derive a payload-leaking
    // Debug implementation. The runtime exposes one redacted record Debug.
    config.skip_debug([".terminal.state"]);
    config.compile_protos(&schemas, &[schema_dir])?;

    let canonical = out_dir.join("generated.rs");
    fs::write(
        &canonical,
        r#"pub mod terminal {
    pub mod state {
        pub mod common { pub mod v1 { include!("generated/terminal.state.common.v1.rs"); } }
        pub mod events { pub mod v1 { include!("generated/terminal.state.events.v1.rs"); } }
        pub mod history { pub mod v1 { include!("generated/terminal.state.history.v1.rs"); } }
        pub mod input { pub mod v1 { include!("generated/terminal.state.input.v1.rs"); } }
        pub mod model { pub mod v1 { include!("generated/terminal.state.model.v1.rs"); } }
        pub mod projection { pub mod v1 { include!("generated/terminal.state.projection.v1.rs"); } }
        pub mod envelope { pub mod v1 { include!("generated/terminal.state.envelope.v1.rs"); } }
    }
}

pub use terminal::state::common::v1::*;
pub use terminal::state::envelope::v1::*;
pub use terminal::state::events::v1::*;
pub use terminal::state::history::v1::*;
pub use terminal::state::input::v1::*;
pub use terminal::state::model::v1::*;
pub use terminal::state::projection::v1::*;
"#,
    )?;
    let mut rust_files = vec![canonical];
    rust_files.extend(schema_relative.iter().map(|relative| {
        let domain = relative.split('/').nth(2).unwrap();
        generated_dir.join(format!("terminal.state.{domain}.v1.rs"))
    }));
    for rust_file in rust_files {
        let status = Command::new("rustup")
            .args(["run", "1.85.0", "rustfmt", "--edition", "2024"])
            .arg(&rust_file)
            .status()?;
        if !status.success() {
            return Err("rustfmt failed for generated terminal state types".into());
        }
    }
    Ok(())
}
