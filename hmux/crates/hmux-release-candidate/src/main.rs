use clap::{Parser, Subcommand};
use hmux_release_candidate::{
    CandidateOptions, VerifyCandidateOptions, create_release_candidate, verify_release_candidate,
};
use hmux_release_trust::ReleaseChannel;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(about = "Build a fail-closed Hmux TUF release candidate")]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate staged trees and create the unsigned hand-off.
    Create {
        #[arg(value_parser = ["stable", "canary"])]
        channel: String,
        source_commit: String,
        workflow_run_id: u64,
        workflow_run_attempt: u64,
        artifact_root: PathBuf,
        output: PathBuf,
    },
    /// Revalidate a downloaded bundle before protected signing.
    Verify {
        #[arg(value_parser = ["stable", "canary"])]
        channel: String,
        source_commit: String,
        workflow_run_id: u64,
        workflow_run_attempt: u64,
        artifact_root: PathBuf,
        candidate: PathBuf,
    },
}

fn main() {
    let arguments = Arguments::parse();
    let result = match arguments.command {
        Command::Create {
            channel,
            source_commit,
            workflow_run_id,
            workflow_run_attempt,
            artifact_root,
            output,
        } => create_release_candidate(CandidateOptions {
            channel: parse_channel(&channel),
            source_commit,
            workflow_run_id,
            workflow_run_attempt,
            artifact_root,
            output,
        }),
        Command::Verify {
            channel,
            source_commit,
            workflow_run_id,
            workflow_run_attempt,
            artifact_root,
            candidate,
        } => verify_release_candidate(VerifyCandidateOptions {
            channel: parse_channel(&channel),
            source_commit,
            workflow_run_id,
            workflow_run_attempt,
            artifact_root,
            candidate,
        }),
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn parse_channel(channel: &str) -> ReleaseChannel {
    match channel {
        "stable" => ReleaseChannel::Stable,
        "canary" => ReleaseChannel::Canary,
        _ => unreachable!("clap restricts channel values"),
    }
}
