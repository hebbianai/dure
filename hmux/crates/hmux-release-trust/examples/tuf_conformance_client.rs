#[tokio::main]
async fn main() {
    if let Err(error) = hmux_release_trust::run_conformance_client().await {
        eprintln!("tuf conformance client failed: {error}");
        std::process::exit(1);
    }
}
