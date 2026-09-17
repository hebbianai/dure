//! Host process lifecycle boundaries.

mod launcher;

pub(crate) use launcher::{
    HOST_PACKET_SCHEMA, HostLaunchPacket, HostSpawnFailure, INTERNAL_HOST_SUBCOMMAND, READY_POLL,
    READY_TIMEOUT, fault_inject_host_spawn_before_start_for_test, inject_managed_create_fault,
    spawn_host, spawn_host_after_preflight,
};
