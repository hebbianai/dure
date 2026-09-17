use super::*;

pub(super) fn collect(descriptors: &[SessionDescriptor]) -> BTreeMap<String, BTreeSet<u32>> {
    let rows = process_rows();
    let roots = descriptors
        .iter()
        .map(|descriptor| {
            (
                descriptor.host_process.process_id,
                descriptor.provider_process.process_id,
            )
        })
        .collect::<Vec<_>>();
    classify(&rows, &roots)
}

fn classify(
    rows: &[process_metrics::ProcessRow],
    roots: &[(u32, u32)],
) -> BTreeMap<String, BTreeSet<u32>> {
    let row_pids = rows.iter().map(|row| row.pid).collect::<BTreeSet<_>>();
    let mut roles = BTreeMap::new();
    let mut hmux_hosts = BTreeSet::new();
    let mut connection_drivers = BTreeSet::new();
    let mut app_servers = BTreeSet::new();
    let mut provider_descendants = BTreeSet::new();
    let mut host_descendants = BTreeSet::new();
    let mut complete_hmux_trees = BTreeSet::new();
    for &(hmux_pid, driver_pid) in roots {
        assert!(row_pids.contains(&hmux_pid), "Hmux host disappeared");
        assert!(
            row_pids.contains(&driver_pid),
            "Codex connection driver disappeared"
        );
        let hmux_descendants = descendant_pids(rows, hmux_pid);
        assert!(
            hmux_descendants.contains(&driver_pid),
            "Hmux host does not own its exact Codex connection driver"
        );
        let direct_children = rows
            .iter()
            .filter(|row| row.parent_pid == driver_pid)
            .map(|row| row.pid)
            .collect::<Vec<_>>();
        assert_eq!(
            direct_children.len(),
            1,
            "Codex connection driver must own exactly one app-server"
        );
        let app_server_pid = direct_children[0];
        hmux_hosts.insert(hmux_pid);
        connection_drivers.insert(driver_pid);
        app_servers.insert(app_server_pid);
        let app_server_descendants = descendant_pids(rows, app_server_pid);
        host_descendants.extend(hmux_descendants.iter().copied().filter(|pid| {
            *pid != driver_pid && *pid != app_server_pid && !app_server_descendants.contains(pid)
        }));
        provider_descendants.extend(app_server_descendants);
        complete_hmux_trees.insert(hmux_pid);
        complete_hmux_trees.extend(hmux_descendants);
    }
    let authority_processes = hmux_hosts
        .union(&connection_drivers)
        .copied()
        .chain(app_servers.iter().copied())
        .collect::<BTreeSet<_>>();
    roles.insert("hmux_host".into(), hmux_hosts);
    roles.insert("codex_connection_driver".into(), connection_drivers);
    roles.insert("codex_app_server".into(), app_servers);
    if !provider_descendants.is_empty() {
        roles.insert("codex_descendant".into(), provider_descendants);
    }
    if !host_descendants.is_empty() {
        // Keep Host-owned helpers in resource totals and cleanup observations;
        // they are outside the provider's connection-driver/app-server tree.
        roles.insert("hmux_descendant".into(), host_descendants);
    }
    let owned = role_processes(&roles);
    assert_eq!(
        owned, complete_hmux_trees,
        "Codex roles must partition ownership"
    );
    authority_processes.iter().for_each(|pid| {
        assert!(
            rows.iter().any(|row| row.pid == *pid && row.rss_kib > 0),
            "owned process RSS must be observable"
        )
    });
    roles
}

#[test]
fn host_helpers_remain_owned_without_becoming_provider_descendants() {
    let rows = [
        (10, 1),
        (11, 10),
        (12, 11),
        (13, 12),
        (14, 10),
        (15, 14),
        (90, 1),
    ]
    .into_iter()
    .map(|(pid, parent_pid)| process_metrics::ProcessRow {
        pid,
        parent_pid,
        rss_kib: 1,
    })
    .collect::<Vec<_>>();
    let roles = classify(&rows, &[(10, 11)]);
    assert_eq!(roles["hmux_host"], BTreeSet::from([10]));
    assert_eq!(roles["codex_connection_driver"], BTreeSet::from([11]));
    assert_eq!(roles["codex_app_server"], BTreeSet::from([12]));
    assert_eq!(roles["codex_descendant"], BTreeSet::from([13]));
    assert_eq!(roles["hmux_descendant"], BTreeSet::from([14, 15]));
    assert_eq!(
        role_processes(&roles),
        BTreeSet::from([10, 11, 12, 13, 14, 15])
    );
}
