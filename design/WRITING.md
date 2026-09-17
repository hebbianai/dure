# UX writing

Write concise, factual copy that helps a person decide what to do next while
several agents are working. Use [SOUL](SOUL.md) for design judgment. Product
copy belongs in semantic message IDs under [src/locales](../src/locales/), with
English canonical and all seven catalogs updated together. Do not maintain a
second catalog of approved screen strings in this document.

- Describe one state or action at a time. Keep narrow surfaces to two sentences
  and badges to short noun phrases.
- For an error or recovery, state what is known, what remains preserved, and the
  next available action. Distinguish unavailable evidence from confirmed loss.
- Describe only guarantees the selected runtime and operation actually provide.
  Reattaching to a live process and recreating a process from saved conversation
  state are different outcomes. Never conceal lost work behind reassuring copy.
- Name the affected resource and consequence before a destructive confirmation.
  Closing a view, disconnecting, and stopping a session must remain distinct.
- Explain an input constraint without blaming the user; include a usable example
  where it helps. Avoid celebration, urgency, and unmeasured performance claims.
- Product copy explains the user's task. Internal runtime classes, receipt JSON,
  rehost terminology and error enums need a localized explanation.
- Compare tools fairly and distinguish implemented behavior from future plans.
  Development status and evidence belong in GitHub Issues.

Use the existing locale terms consistently:

| Concept | English | Korean |
| --- | --- | --- |
| OS window | window | 창 |
| User-arranged group of panes | space | 스페이스 |
| One view within a space | pane | pane |
| Registered AI work | agent | 에이전트 |
| Runtime/conversation instance | session | 세션 |

Do not use desktop, tab, panel, or window as synonyms for a space or pane.
Preserve established technical names such as worktree where translation would
obscure the action. Status labels and accessible descriptions come from the
existing [agent state model](../src/lib/agents/agentStateModel.ts) and
[status components](../src/components/agents/StatusBits.tsx); do not duplicate
their palette or state mapping here. Color alone must not convey state.
