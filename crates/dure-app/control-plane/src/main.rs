use std::path::PathBuf;

use dure_control_plane::{
    ActivateStagedOptions, ClaudeStructuredRuntimeOptions, GatewayOptions, ServeOptions,
    activate_staged, codex_connection_driver, control_plane_identity, decode_gateway_socket_hex,
    gateway, preflight, serve,
};

enum Command {
    #[cfg(unix)]
    ManagedClaudeHook,
    McpStdioRelay(Vec<String>),
    McpMemoryRelay(Vec<String>),
    ActivateStaged(ActivateStagedOptions),
    CodexConnectionDriver(Vec<String>),
    CodexNativeDriver(Vec<String>),
    OpenCodeConnectionDriver(Vec<String>),
    PiConnectionDriver(Vec<String>),
    Gateway(GatewayOptions),
    Identity,
    Preflight(ServeOptions),
    Serve(ServeOptions),
}

fn usage() -> ! {
    eprintln!(
        "usage: dure-control-plane identity\n       dure-control-plane preflight --home <DURE_HOME> --hmux-bin <PATH> --hmux-runtime-bin <PATH> --hmux-discovery-root <PATH> [--claude-node-bin <PATH> --claude-host-entrypoint <PATH> --claude-relay-bin <PATH> --claude-runtime-root <PATH>]\n       dure-control-plane serve --home <DURE_HOME> [--launch-executable <PATH>] --hmux-bin <PATH> --hmux-runtime-bin <PATH> --hmux-discovery-root <PATH> [--claude-node-bin <PATH> --claude-host-entrypoint <PATH> --claude-relay-bin <PATH> --claude-runtime-root <PATH>] [--expected-generation <GENERATION>] [--activation-source-generation <GENERATION>] [--staged]\n       dure-control-plane activate-staged --home <DURE_HOME> --source-generation <GENERATION> --target-generation <GENERATION>\n       dure-control-plane gateway --socket-hex <HEX> --expected-generation <GENERATION>\n       dure-control-plane codex-connection-driver --endpoint <PATH> --upstream <PATH> -- <CODEX> app-server --listen unix://<PATH>\n       dure-control-plane codex-native-driver --runtime <PATH> -- <CODEX> [ARGS...]\n       dure-control-plane opencode-connection-driver --endpoint <PATH> --session <SESSION_ID> --permission-mode <MODE> -- <OPENCODE>\n       dure-control-plane pi-connection-driver --endpoint <PATH> -- <PI> --mode rpc"
    );
    eprintln!(
        "       dure-control-plane mcp-stdio-relay --node <PATH> --worker <PATH> --catalogue <PATH> --receipt-json <JSON> [--idle-ms <MS>]"
    );
    eprintln!(
        "       dure-control-plane mcp-memory-relay --node <PATH> --worker <PATH> --memory-file <PATH> [--idle-ms <MS>]"
    );
    std::process::exit(2);
}

fn parse_args() -> Command {
    let mut arguments = std::env::args().skip(1);
    let command = arguments.next().unwrap_or_else(|| usage());
    #[cfg(unix)]
    if command == "managed-claude-hook" {
        if arguments.next().is_some() {
            usage();
        }
        return Command::ManagedClaudeHook;
    }
    if command == "identity" {
        if arguments.next().is_some() {
            usage();
        }
        return Command::Identity;
    }
    if command == "mcp-stdio-relay" {
        return Command::McpStdioRelay(arguments.collect());
    }
    if command == "mcp-memory-relay" {
        return Command::McpMemoryRelay(arguments.collect());
    }
    if command == "codex-connection-driver" {
        return Command::CodexConnectionDriver(arguments.collect());
    }
    if command == "codex-native-driver" {
        return Command::CodexNativeDriver(arguments.collect());
    }
    if command == "pi-connection-driver" {
        return Command::PiConnectionDriver(arguments.collect());
    }
    if command == "opencode-connection-driver" {
        return Command::OpenCodeConnectionDriver(arguments.collect());
    }
    if command == "activate-staged" {
        let mut home = None;
        let mut source_generation = None;
        let mut target_generation = None;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--home" => home = arguments.next().map(PathBuf::from),
                "--source-generation" => source_generation = arguments.next(),
                "--target-generation" => target_generation = arguments.next(),
                _ => usage(),
            }
        }
        return Command::ActivateStaged(ActivateStagedOptions {
            home: home.unwrap_or_else(|| usage()),
            source_generation: source_generation.unwrap_or_else(|| usage()),
            target_generation: target_generation.unwrap_or_else(|| usage()),
        });
    }
    if command == "gateway" {
        let mut socket_hex = None;
        let mut expected_generation = None;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--socket-hex" => socket_hex = arguments.next(),
                "--expected-generation" => expected_generation = arguments.next(),
                _ => usage(),
            }
        }
        return Command::Gateway(GatewayOptions {
            socket_path: decode_gateway_socket_hex(&socket_hex.unwrap_or_else(|| usage()))
                .unwrap_or_else(|_| usage()),
            expected_generation: expected_generation.unwrap_or_else(|| usage()),
        });
    }
    if !matches!(command.as_str(), "preflight" | "serve") {
        usage();
    }
    let mut home = None;
    let mut hmux_bin = None;
    let mut hmux_runtime_bin = None;
    let mut hmux_discovery_root = None;
    let mut claude_node_bin = None;
    let mut claude_host_entrypoint = None;
    let mut claude_relay_bin = None;
    let mut claude_runtime_root = None;
    let mut launch_executable = None;
    let mut expected_generation = None;
    let mut activation_source_generation = None;
    let mut staged = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--home" => home = arguments.next().map(PathBuf::from),
            "--hmux-bin" => hmux_bin = arguments.next().map(PathBuf::from),
            "--hmux-runtime-bin" => hmux_runtime_bin = arguments.next().map(PathBuf::from),
            "--hmux-discovery-root" => hmux_discovery_root = arguments.next().map(PathBuf::from),
            "--claude-node-bin" => claude_node_bin = arguments.next().map(PathBuf::from),
            "--claude-host-entrypoint" => {
                claude_host_entrypoint = arguments.next().map(PathBuf::from)
            }
            "--claude-relay-bin" => claude_relay_bin = arguments.next().map(PathBuf::from),
            "--claude-runtime-root" => claude_runtime_root = arguments.next().map(PathBuf::from),
            "--launch-executable" if command == "serve" => {
                launch_executable = arguments.next().map(PathBuf::from)
            }
            "--expected-generation" => expected_generation = arguments.next(),
            "--activation-source-generation" if command == "serve" => {
                activation_source_generation = arguments.next()
            }
            "--staged" if command == "serve" => staged = true,
            _ => usage(),
        }
    }
    let claude_structured_runtime = match (
        claude_node_bin,
        claude_host_entrypoint,
        claude_relay_bin,
        claude_runtime_root,
    ) {
        (None, None, None, None) => None,
        (Some(node_bin), Some(host_entrypoint), Some(relay_bin), Some(runtime_root)) => {
            Some(ClaudeStructuredRuntimeOptions {
                node_bin,
                host_entrypoint,
                relay_bin,
                runtime_root,
            })
        }
        _ => usage(),
    };
    let options = ServeOptions {
        home: home.unwrap_or_else(|| usage()),
        hmux_bin: hmux_bin.unwrap_or_else(|| usage()),
        hmux_runtime_bin: hmux_runtime_bin.unwrap_or_else(|| usage()),
        hmux_discovery_root: hmux_discovery_root.unwrap_or_else(|| usage()),
        claude_structured_runtime,
        launch_executable,
        expected_generation,
        activation_source_generation,
        staged,
    };
    if command == "preflight" {
        Command::Preflight(options)
    } else {
        Command::Serve(options)
    }
}

async fn execute(command: Command) -> Result<(), dure_control_plane::ControlPlaneError> {
    match command {
        Command::McpMemoryRelay(arguments) => {
            dure_control_plane::mcp_stdio_relay::memory::run_from_arguments(arguments.into_iter())
                .await
                .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.to_string()))
        }
        Command::McpStdioRelay(arguments) => {
            dure_control_plane::mcp_stdio_relay::run_from_arguments(arguments.into_iter())
                .await
                .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.to_string()))
        }
        #[cfg(unix)]
        Command::ManagedClaudeHook => dure_control_plane::managed_claude_hook::run()
            .await
            .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.code().into())),
        Command::ActivateStaged(options) => activate_staged(options).map(|_| ()),
        Command::CodexConnectionDriver(arguments) => {
            codex_connection_driver::run_from_arguments(arguments.into_iter().map(Into::into))
                .await
                .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.to_string()))
        }
        Command::CodexNativeDriver(arguments) => {
            codex_connection_driver::native::run_from_arguments(arguments.into_iter().map(Into::into))
                .await
                .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.to_string()))
        }
        Command::PiConnectionDriver(arguments) => {
            dure_control_plane::pi_connection_driver::run_from_arguments(
                arguments.into_iter().map(Into::into),
            )
            .await
            .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.to_string()))
        }
        Command::OpenCodeConnectionDriver(arguments) => {
            dure_control_plane::opencode_connection_driver::run_from_arguments(
                arguments.into_iter().map(Into::into),
            )
            .await
            .map_err(|error| dure_control_plane::ControlPlaneError::Message(error.to_string()))
        }
        Command::Gateway(options) => gateway(options).await,
        Command::Identity => {
            println!(
                "{}",
                serde_json::to_string(&control_plane_identity())
                    .expect("control-plane identity is serializable")
            );
            Ok(())
        }
        Command::Preflight(options) => match preflight(&options).await {
            Ok(receipt) => {
                println!(
                    "{}",
                    serde_json::to_string(&receipt).expect("preflight receipt is serializable")
                );
                Ok(())
            }
            Err(error) => Err(error),
        },
        Command::Serve(options) => serve(options).await,
    }
}

fn main() {
    let command = parse_args();
    // Hooks and MCP endpoints forward serial I/O, not service work. Each owns
    // its completed input reader and does not need a resident worker pool.
    let (mut builder, owns_stdin) = match &command {
        #[cfg(unix)]
        Command::ManagedClaudeHook => (tokio::runtime::Builder::new_current_thread(), true),
        Command::McpStdioRelay(_) | Command::McpMemoryRelay(_) => {
            (tokio::runtime::Builder::new_current_thread(), true)
        }
        _ => (tokio::runtime::Builder::new_multi_thread(), false),
    };
    let runtime = builder.enable_all().build().expect("control-plane runtime");
    let result = runtime.block_on(execute(command));
    if owns_stdin {
        // Tokio's stdin reader can remain blocked after the invocation expires.
        // The command has already awaited its owned worker's exit. Do not wait
        // for more client input after it has completed or failed.
        runtime.shutdown_timeout(std::time::Duration::ZERO);
    } else {
        drop(runtime);
    }
    if let Err(error) = result {
        eprintln!("dure-control-plane: {error}");
        std::process::exit(1);
    }
}
