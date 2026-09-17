---
name: slack
description: Connect a Slack channel or bot DM to a Dure Pro project and continue the same agent conversation from either surface.
---

Use `dure slack` for the official Dure Slack connector. Dure owns tasks and
conversation history; this integration handles Slack delivery only.

When asked to connect Slack:
- Use the user's chosen workspace, channel and Dure project. Ask only for
  missing connection details. A shared objective is optional and can be
  established or changed in the conversation.
- Run `dure slack manifest` for the Slack app manifest. The workspace app needs
  an app-level token with `connections:write` and its installed bot token.
  Credentials belong in the user's local environment, never in chat, a
  repository, configuration JSON or tool output.
- Use `dure projects list --json` to resolve the registered project and the
  existing provider selection. Write a private connector configuration outside
  the repository: schemaVersion 1, teamId, channels with channelId, projectId and
  providerId. Each route can include an objective, a Dure Space (`space`), and
  an existing local or SSH backend profile (`backend`). Keep one connector for
  the workspace's shared @Dure; it routes to all configured servers. Existing
  threads keep their original server when channel defaults change.
- Start `dure slack serve --config FILE` in a durable terminal owned by the
  user. It requires Node.js 22+ and a Pro development backend. The connection
  lasts while that command runs. Report the actual result; do not add a
  separate readiness checklist or silently retry failed tasks.
- To share work already running in Dure, use `dure slack share --config FILE
  --agent ID --channel ID` while the connector runs. Specify `--backend ID`
  when the task uses a different backend than the channel default. This posts
  a thread linked to the existing task and shares subsequent updates; it does
  not copy earlier private conversation. Keep `--request-id ID` unchanged when
  checking the result of an interrupted command. A new command can explicitly
  try again after a reported failure.
- Use `dure slack status --config FILE` to inspect recorded delivery state.
  Stopping the connector preserves tasks and conversations in Dure.
- Dure's Pro development UI also manages connections from the Slack plugin
  settings. It uses the same connector and server routes as the CLI.
- Provider questions and permission requests appear in the task thread with
  answer controls available to every teammate. Ordinary replies remain new
  directions. Acknowledging a Slack interaction is not proof that the provider
  received the answer; use the actual delivery result.

A mention starts work in its own worktree. Anyone in the connected thread can
continue it without another mention; every participant has equal standing.
Do not invent a second goal queue, supervisor, approval ladder or Slack-only
task store. Reuse the common agent conversation. Ask participants together only
when their directions conflict.

When explicitly entrusted with an ongoing goal, use the installed
`agent_goal_get` and `agent_goal_put` tools (or `dure goal`) with this conversation's
Dure agent ID. Read the current revision before updating it. Keep the upper
objective intact, inspect existing work and newly discovered problems, and
choose the next useful action. Compatible teammate directions have equal
standing; ask only about actual missing information or conflicts.

An active goal continues after successful work segments. Pausing stops future
continuation; already admitted work may finish. Failed or canceled work is not
automatically retried. Mark the goal complete only after verifying its outcome.
Dure and Slack consume the same goal state; subsequent changes appear in the
shared thread. Sharing an existing task does not backfill its earlier goal.

This is a development preview, not a released paid Pro service. Actual Slack
installation and an available execution host are still required. Do not promise
an always-on host or production entitlement from a local connection or UI mode.
