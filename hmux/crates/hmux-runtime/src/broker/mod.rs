//! Runtime broker entry points and their domain orchestration.

mod inherited_descriptors;
mod standalone;

use hmux_runtime_contract::{
    MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND, MANAGED_ATTACH_BROKER_SUBCOMMAND,
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND, MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2,
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, MANAGED_REHOST_BROKER_SUBCOMMAND,
    MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND, MANAGED_STOP_BROKER_SUBCOMMAND,
    MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND, STANDALONE_CREATE_BROKER_SUBCOMMAND,
};

use standalone::run as run_standalone;

pub(crate) fn run(command: &str) -> Option<super::Result<()>> {
    let entry = match command {
        STANDALONE_CREATE_BROKER_SUBCOMMAND => run_standalone,
        MANAGED_CREATE_BROKER_SUBCOMMAND => super::managed_create_broker,
        MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND => super::managed_create_reconcile::broker,
        MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND => super::managed_create_advance::broker,
        MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND => super::managed_create_chain_stop::broker,
        MANAGED_CREATE_CHAIN_STOP_BROKER_SUBCOMMAND_V2 => {
            super::managed_create_chain_stop::broker_v2
        }
        MANAGED_ATTACH_BROKER_SUBCOMMAND => super::managed_attach_broker,
        MANAGED_AGENT_STATE_REPORT_BROKER_SUBCOMMAND => super::managed_agent_state_report::broker,
        MANAGED_STOP_BROKER_SUBCOMMAND => super::managed_stop_broker,
        MANAGED_REHOST_BROKER_SUBCOMMAND => super::managed_rehost_broker,
        MANAGED_REHOST_RECONCILE_BROKER_SUBCOMMAND => {
            super::managed_rehost_reconcile_broker
        }
        MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND => super::managed_stop_reconcile_broker,
        _ => return None,
    };
    Some(invoke(entry))
}

fn invoke(entry: fn() -> super::Result<()>) -> super::Result<()> {
    inherited_descriptors::close_all().map_err(|error| {
        format!("could not sanitize inherited runtime broker descriptors: {error}")
    })?;
    entry()
}
