use std::process::ExitCode;

fn main() -> ExitCode {
    match terminal_core_ghostty_proof::supply::run_cli(std::env::args_os()) {
        Ok(output) => {
            println!("recipe_id={}", output.recipe_id);
            println!("artifact_id={}", output.artifact_id);
            println!("artifact_root={}", output.artifact_root.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("stage-ghostty-vt: {error}");
            ExitCode::FAILURE
        }
    }
}
