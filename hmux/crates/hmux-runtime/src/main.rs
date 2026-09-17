#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(feature = "terminal-state-stream")]
mod agent_prompt_admission;
#[cfg(unix)]
mod capacity_maintenance;
mod controller_input;
mod controller_input_effect;
mod input_receipt;
mod input_transaction;
#[cfg(feature = "terminal-state-stream")]
mod structured_upstream;
#[cfg(feature = "terminal-state-stream")]
mod terminal_geometry;

fn runtime_arguments(arguments: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut arguments = arguments.into_iter().collect::<Vec<_>>();
    if arguments
        .first()
        .is_some_and(|argument| argument == "--no-autostart")
    {
        arguments.remove(0);
    }
    arguments
}

fn prepare_host_admission_capacity(discovery_root: &std::path::Path) {
    // Available headroom needs no global ledger/lifecycle sweep. In particular,
    // unrelated create-shard owners must not serialize a new pane's startup.
    if hmux_host::local_discovery::DiscoveryRoot::open(discovery_root)
        .and_then(|root| root.registration_capacity())
        .is_ok_and(|capacity| {
            #[cfg(unix)]
            {
                capacity.remaining > 0
            }
            #[cfg(not(unix))]
            {
                capacity.used
                    < hmux_host::local_discovery::DiscoveryGcPolicy::default().max_session_entries
            }
        })
    {
        return;
    }
    // Cleanup is preparatory. Run it before a create transaction acquires
    // recovery locks; Host registration remains the sole admission authority.
    #[cfg(unix)]
    let _ = managed_abandonment::maintain_completed_create_lifecycles(discovery_root);
    let _ = hmux_client::maintain_registration_capacity(discovery_root);
}

#[cfg(test)]
mod runtime_argument_tests {
    use super::runtime_arguments;

    #[test]
    fn only_the_leading_runtime_option_is_consumed() {
        assert_eq!(
            runtime_arguments(
                [
                    "--no-autostart",
                    "internal-command",
                    "provider",
                    "--no-autostart",
                ]
                .map(str::to_string),
            ),
            ["internal-command", "provider", "--no-autostart"]
        );
        assert_eq!(
            runtime_arguments(
                ["internal-command", "provider", "--no-autostart"].map(str::to_string),
            ),
            ["internal-command", "provider", "--no-autostart"]
        );
    }
}

#[cfg(unix)]
include!("unix_runtime.rs");

#[cfg(windows)]
include!("windows_runtime.rs");

#[cfg(not(any(unix, windows)))]
compile_error!("hmux-runtime requires a supported Unix or Windows target");
