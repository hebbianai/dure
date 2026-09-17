# Product-neutral orchestration

This crate owns durable workflow transitions. The Dure control plane hosts it;
runtime, provider, UI, CLI and tracker integrations are consumers or adapters.

Start at [lib.rs](src/lib.rs). The [contract](src/contract/),
[domain](src/domain/), [ports](src/ports/) and [service](src/service.rs) define the
current API and ownership boundaries. Check
[import isolation](tests/import_boundary.rs) and
[Store/service conformance](tests/interaction_vertical_slice.rs) when changing
those boundaries; do not duplicate the protocol or migration status here.

The installed [agent integration](integration/SKILL.md) is a packaged runtime
input. Keep its instructions aligned with the shared client and MCP
schema. Plans, migrations and remaining acceptance belong to the work issue.
