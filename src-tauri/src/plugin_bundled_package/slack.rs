use std::collections::BTreeMap;

use dure_app::{
    AgentIntegrationIdV2, PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2,
};

use super::{owned, resource_path};

pub(super) fn snapshot() -> Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2> {
    PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
        owned(include_bytes!("../../../plugins/slack/dure-plugin.json")),
        BTreeMap::new(),
        BTreeMap::from([
            (
                AgentIntegrationIdV2::new("dure.slack.codex").expect("bundled integration id"),
                BTreeMap::from([
                    (
                        resource_path("./.agents/plugins/marketplace.json"),
                        owned(include_bytes!(
                            "../../../plugins/slack/agents/codex/.agents/plugins/marketplace.json"
                        )),
                    ),
                    (
                        resource_path("./plugins/dure-slack/.codex-plugin/plugin.json"),
                        owned(include_bytes!(
                            "../../../plugins/slack/agents/codex/plugins/dure-slack/.codex-plugin/plugin.json"
                        )),
                    ),
                    (
                        resource_path("./plugins/dure-slack/skills/slack/SKILL.md"),
                        owned(include_bytes!(
                            "../../../plugins/slack/agents/codex/plugins/dure-slack/skills/slack/SKILL.md"
                        )),
                    ),
                ]),
            ),
            (
                AgentIntegrationIdV2::new("dure.slack.claude").expect("bundled integration id"),
                BTreeMap::from([
                    (
                        resource_path("./.claude-plugin/marketplace.json"),
                        owned(include_bytes!(
                            "../../../plugins/slack/agents/claude/.claude-plugin/marketplace.json"
                        )),
                    ),
                    (
                        resource_path("./plugins/dure-slack/.claude-plugin/plugin.json"),
                        owned(include_bytes!(
                            "../../../plugins/slack/agents/claude/plugins/dure-slack/.claude-plugin/plugin.json"
                        )),
                    ),
                    (
                        resource_path("./plugins/dure-slack/skills/slack/SKILL.md"),
                        owned(include_bytes!(
                            "../../../plugins/slack/agents/claude/plugins/dure-slack/skills/slack/SKILL.md"
                        )),
                    ),
                ]),
            ),
        ]),
    )
}
