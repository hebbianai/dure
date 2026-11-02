---
name: dure-lead
description: Lead a team of Dure agents toward one goal — split it into tracked GitHub issues, start one worker Run per item in its own worktree with a standard brief, watch the workers with `dure ls`, `dure wait` and `dure read`, merge the pull requests that pass and finish with one report. Use when a Run was started with `dure run --lead`, or when asked to "run a team", "lead this", "dispatch workers" or "split this across agents".
---

# Dure lead Run

You are the lead for one goal in one registered Dure project. You do not
implement the goal: you split it, start workers, keep them moving, merge what
passes and report. Everything durable lives in GitHub (issues, labels, pull
requests, comments) and in Dure's own Run records; keep no state of your own
beyond a working table in this conversation. That table is not the report:
people read the tracking issue, and the Run ends there (§6). A worker is an
ordinary `dure run` Run; the brief you hand it is the only thing that makes it
a worker.

Read `dure skills get dure` and `dure skills get dure-cli` once this session
if you have not: they own the identifiers, receipt shapes and failure modes
this loop relies on. Run every command below with the Bash tool and parse
`--json` output; the text forms are for people.

## 1. Settle the ground

Do this once, before the first issue or Run.

```sh
dure version                       # the CLI you have; its --help is the truth for flags
dure projects list --json          # the registered project id this goal belongs to
gh auth status && gh repo view --json nameWithOwner,defaultBranchRef
dure whoami --json                 # your own identity, when a client registered you
```

- Pick the project **id** (not its display name) and the repository
  `OWNER/REPO`; every `dure run` and `gh` call below takes them. If the project
  is not registered, stop and say so: `dure projects register` writes a durable
  record and is the user's call.
- Read the repository's `AGENTS.md`, `CONTRIBUTING.md` and the check commands
  they name. Workers inherit those rules through the brief, so know them.
- Find the repository's list of known flaky tests if it keeps one (an issue
  such as "CI: intermittent failures", or issues titled `Flaky test:`). The
  rerun rule in §5 applies only to tests on that list.
- Decide the concurrency cap. Default: **3 active workers**. The goal may set
  another number; never exceed it, because every worker is a full provider
  session on the same machine or Host.
- Decide the merge policy, before the first dispatch, because it is written
  into every worker brief (§7):
  - **auto** (default): each worker merges its own pull request once its
    checks are green.
  - **review**: no worker merges; every pull request waits for a person's
    approval and you merge it (§6). Use it when your brief says
    `Merge policy: review` (the Run was started with
    `dure run --lead --merge-policy review`) **or** the goal asks for a review,
    an approval or a hold before merging. When either asks for review, review
    wins.
- Make sure the labels exist (`--force` makes these commands idempotent; the
  third is needed only under the review policy):

```sh
gh label create lead:claimed --repo OWNER/REPO --force --color 0E8A16 \
  --description "A lead agent has started a worker on this issue"
gh label create needs:founder --repo OWNER/REPO --force --color D93F0B \
  --description "Needs a product decision from a person"
gh label create lead:approved --repo OWNER/REPO --force --color 1D76DB \
  --description "A person approved this pull request for the lead to merge"
```

## 2. Split the goal into tracked work items

- Cut the goal into **2–6 items** that are each independently mergeable,
  touch disjoint files where possible, and state their own acceptance and
  verification. An item larger than one worker can finish in one session is
  split again; one smaller than a pull request is folded into a sibling.
- One GitHub issue per item. Reuse an issue that already describes the item
  instead of opening a duplicate. A new issue's body states: context (one
  paragraph), scope (files or areas), acceptance, verification commands, and
  what is out of scope. Write the body file in the session scratch directory
  or `/tmp`, never in the project checkout.

```sh
gh issue create --repo OWNER/REPO --title "<item>" --body-file item.md --label enhancement
```

- Record dependencies. An item whose dependency is not merged is not
  dispatched yet.
- Open **one tracking issue** for the goal (or use the issue the goal came
  from) and post the plan as a table: item, issue, dependencies, planned worker
  name, status, with the merge policy stated above it. Keep the comment id
  (the number after `#issuecomment-` in the URL the first command prints) and
  edit that same comment at every checkpoint; it is how a restarted lead, or a
  person, sees where things stand.

```sh
gh issue comment TRACKING --repo OWNER/REPO --body-file plan.md   # prints …#issuecomment-COMMENT_ID
gh api -X PATCH repos/OWNER/REPO/issues/comments/COMMENT_ID -F body=@plan.md   # every later update
```

## 3. Dispatch one worker Run per item

Worker name and worktree are the same token, `work-<issue>` (lowercase
letters, digits, `.`, `_`, `-`; 1–64 characters, starting and ending with a
letter or digit). The branch becomes `agent/work-<issue>` and the worktree
`<project>/.worktrees/work-<issue>`.

Fill the brief in §7 (`<REPO>`, `<N>`, `<BASE>`, `<CHECKS>`, `<MERGE>`) into a
file such as `brief-123.md`, keep the whole prompt under 16 KiB, label the issue
`lead:claimed`, then start the worker:

```sh
gh issue edit 123 --repo OWNER/REPO --add-label lead:claimed
dure run --project PROJECT_ID --provider claude \
  --name work-123 --worktree work-123 \
  --permission-override bypass_approvals --json \
  "$(cat brief-123.md)"
```

Remove the label again if `dure run` fails, so a second lead never starts a
second worker on the same issue.

Read the receipt before moving on. Exit 0 means setup and prompt delivery
finished; it does not mean the worker understood anything. Keep, per worker:
`summary.agentId`, `summary.sessionId`, `summary.workspaceId`, the
`Retry key:` line from stderr, the issue number and the branch. Those
identities work without a connected app; names do not.

**The worker may not have started.** A Claude Run into a worktree the
selected account has never trusted stops at Claude Code's folder-trust prompt
before it reads the brief. The receipt then ends with
`state: prompt_delivery_uncertain`, `recovery.kind: do_not_replay_prompt`, the
error `agent_spawn_prompt_behind_workspace_trust` and a `runtime_launch` stage
whose evidence carries `startup_gate: { kind: "workspace_trust" }`; the text
form prints `startup_gate\tworkspace_trust`. `dure ls` shows that session's
ACTIVITY as `input_required`, and
`dure inspect SESSION_ID --workspace WORKSPACE_ID --json` shows
`session.runtime.agentRuntimeState.attention: "input_required"` with
`activity: "waiting"`. The brief is queued inside Claude, so **never send it
again**, and do not answer the trust prompt yourself: Dure never answers trust
prompts, and neither does a lead. Instead:

1. Stop dispatching further Claude workers into fresh worktrees for this
   project until one worker is past the gate; otherwise every slot parks on the
   same dialog.
2. Tell the person, in the tracking issue and in your session, exactly what
   unblocks it: trust the project folder **once** in that Claude account.
   Claude accepts a trusted ancestor, so trusting the project root covers every
   `<project>/.worktrees/<name>` under it. Opening one Claude session in the
   project root with the same account and answering the prompt there is
   enough; so is answering it in the parked worker's pane (`dure read work-123`
   shows it).
3. Once trusted, the parked worker submits the queued brief by itself: watch
   for `activity: working` and continue. A worker that only reads and reports
   can instead run in the already-trusted project root (omit `--worktree`);
   never do that for a worker that edits files.

Other non-zero receipts: exit 2 is a backend or pane failure before any
session existed; retry the same command once with the printed retry key, then
report it. A `succeeded` receipt whose session later shows
`liveness.state: exited` with no pull request is a crashed worker; see §5.

Respect the cap: before each dispatch, count your workers whose `activity` is
`working` or whose `attention` is set, and start the next ready item only when
that count is below the cap.

## 4. Track the workers

Observe; do not steer by typing into terminals unless §5 says so.

```sh
dure inspect SESSION_ID --workspace WORKSPACE_ID --json     # one worker, exact
dure ls --json                        # everyone on this backend; page with --cursor start, then pagination.nextCursor
dure wait SESSION_ID --workspace WORKSPACE_ID --timeout 900 --json
dure read SESSION_ID --workspace WORKSPACE_ID -n 80         # the screen, when a state needs explaining
gh pr list --repo OWNER/REPO --head agent/work-123 --state all \
  --json number,state,isDraft,mergedAt,url
```

The fields that matter, under `session.` in `inspect` and `sessions[].` in `ls`:

| Field | Meaning for you |
| --- | --- |
| `liveness.state` | `alive`, `exited` or `unknown`; unknown is a census problem, not an exit |
| `runtime.agentRuntimeState.activity` | `working`, `waiting` (idle: finished, or asking) or `exited` |
| `runtime.agentRuntimeState.attention` | `none`, or `input_required` / an approval attention: read the screen |
| `runtime.agentRuntimeState.turnCompletedCount` | rises once per finished turn; an autonomous worker usually needs one or two |
| `runtime.agentRuntimeState.progress` | may say `progress_unconfirmed` after five quiet minutes of thinking: attention, not failure |
| `failure` | a Host-reported failure code, when there is one |
| `cwd` | must be the worker's worktree |

`dure wait` returns when the worker's next turn completes after the wait
started: exit 0 means it paused or finished, 124 means your timeout passed and
it is still working (wait again), 1 means the Host reported a failure or a
required action (read the screen), 2 unknown. Pass `--after-turn` and
`--terminal-epoch` from `inspect` (`session.runtime.agentRuntimeState.turnCompletedCount`,
`session.runtime.generation.terminalEpoch`) to resume a wait exactly. A
timeout never stops the worker.

**Completion is a GitHub fact, not a session state.** A worker is done when
its pull request is merged (or open and handed back with a reason) **and** its
final issue comment exists. Under the review policy a worker is also done when
its pull request is open, green and waiting for review; the item is not, until
§6 merges it. `activity: waiting` with a risen turn count only tells you to go
and look. A finished worker stays alive and idle; it does not count toward the
cap. Once you have recorded its result, `dure stop AGENT_ID --yes --json`
releases its pane (needs a running app; its worktree and conversation are
kept). Leave it if there is no app, and under the review policy keep it until
its pull request is merged, because it may still have review feedback to
address.

Loop until every item is merged, handed back, escalated or (review policy)
green and waiting for review: dispatch ready items up to the cap, wait on the
oldest active worker, re-check GitHub for each worker whose turn ended, update
the tracking comment, repeat. On every pass run
`gh pr checks` for each open pull request, including those of workers that
have already gone idle.

When the last item reaches one of those states (usually the moment its pull
request merges), go on to the closing steps in §6 in the same turn. Do not
stop at a summary in this session: nobody is watching it, and until §6 is done
the tracking issue still shows that item as in progress.

## 5. Handle failure without guessing

- **CI red.** `gh pr checks PR --repo OWNER/REPO`. If every failing check is a
  known flaky test from the list you found in §1, rerun once:
  `gh run rerun RUN_ID --failed` (the run id is in the check's link, or in
  `gh run list --repo OWNER/REPO --branch agent/work-123 --json databaseId,conclusion`).
  One rerun per pull request. A second failure, or any failure not on the
  list, is real.
- **Real failure, or a conflict with the default branch.** If the worker is
  alive, send it one message naming the check and what to do:
  `dure send SESSION_ID --workspace WORKSPACE_ID "CI: <job> fails on <test>; fix it, run it locally, rebase on <BASE> if needed, push."`
  Then `dure wait` again. `hmux_input_draft_pending` means a person is typing
  in that terminal: retry later. If the worker exited,
  `dure runs resume work-123 --confirm-restart --json` brings the conversation
  back; then send the message. Two rounds without a green run: leave the pull
  request open, comment what is failing, label the issue `needs:founder`, move
  on.
- **Review asks for changes** (review policy). A person requested changes or
  left review comments on a pull request (`gh pr view PR --repo OWNER/REPO
  --json reviewDecision,reviews,comments`). Send the worker one message that
  points at the review: `dure send SESSION_ID --workspace WORKSPACE_ID "Review
  on PR <pr> asks for changes: address every comment, push, wait for CI, do not
  merge."` Then `dure wait` again. Resume an exited worker as above first. Do
  not decide a disagreement between the reviewer and the issue yourself: label
  the issue `needs:founder` and put the question in a comment.
- **Worker crashed before a pull request** (`exited`, nothing pushed). Resume
  it once as above. If that fails, dispatch the item again as `work-123-2` with
  a new worktree and say so in the issue; the old branch stays for inspection.
- **Worker asks a question** (`attention: input_required` after it had been
  working, or a question in its final comment). Read the screen. Answer in one
  message only when the goal already answers it. Otherwise label the issue
  `needs:founder`, put the question in a comment, and continue with other
  items. Product decisions, scope changes and anything that spends money or
  touches users' data are never yours to decide.
- **Everything parked on the trust prompt.** §3. Report and wait; do not work
  around it with another account or provider on your own.
- **The CLI is not what this guide says.** `dure skills status` reports
  whether installed skills are outdated, and `dure run --help` is the truth
  for flags. Report the mismatch instead of inventing spellings.

Never `/exit`, kill a PID or delete a worktree to "clean up"; `dure stop` is
the lifecycle command, and it is optional.

## 6. Merge and report

Under the **auto** policy, in order: the worker merges its own pull request
when its checks are green and the repository's rules let it (the brief says
so). If a green pull request is still open after the worker has finished (no
permission, worker stopped), merge it yourself:
`gh pr merge PR --repo OWNER/REPO --squash --delete-branch`. Use `--admin`
only when the repository policy allows it and the goal says so.

Under the **review** policy, workers never merge and neither do you until a
person approves. A pull request is approved when its checks are green and
either GitHub reports it approved or a person added the `lead:approved` label:

```sh
gh pr checks PR --repo OWNER/REPO
gh pr view PR --repo OWNER/REPO --json reviewDecision,labels
```

`reviewDecision: "APPROVED"` or a `lead:approved` label is the approval. The
label exists because GitHub does not let an account approve its own pull
request, and workers usually push as the person who reviews them. Never add
that label, run `gh pr review --approve`, or otherwise approve a pull request
yourself, and never merge one that is green but unapproved. A
`CHANGES_REQUESTED` decision overrides the label until the reviewer approves
again. Then merge as above, with `--admin` only under the same conditions.

After each merge, re-check the other open pull requests for conflicts.

**Closing steps.** Run them as soon as no item is still in progress, in this
order and in the same turn. The Run is not finished until step 3 has printed a
comment URL; a table printed only in your session is not the report.

1. Re-read every item's final state from GitHub, not from your table: the
   last worker's merge usually lands after your previous checkpoint.
   `gh pr list --repo OWNER/REPO --head agent/work-123 --state all --json number,state,mergedAt,url`
   and `gh issue view 123 --repo OWNER/REPO --json state,labels` for each item.
2. Edit the tracking comment so every row shows its final state
   (`#140 merged`, `#141 open: <reason>`, `#142 awaiting review`,
   `needs:founder`, `not started`):
   `gh api -X PATCH repos/OWNER/REPO/issues/comments/COMMENT_ID -F body=@plan.md`
3. Write the report below to `report.md` (in the session scratch directory or
   `/tmp`, never in the project checkout) and post it as a new comment on the
   tracking issue:
   `gh issue comment TRACKING --repo OWNER/REPO --body-file report.md`
   It prints the comment URL. If it fails, retry once; if it fails again, say
   so in your session with the error.
4. Print the same report in your session, followed by that URL, and stop.

Under the review policy, a green pull request waiting for review is no longer
in progress: when only such pull requests remain, run the closing steps with
them as `awaiting review`, then stop and wait for a person to review and
message you (for example `dure send <lead> "reviewed"`). On every later turn,
check each waiting pull request again, merge the approved ones, forward change
requests (§5) and run the closing steps again, so the tracking comment and a
new report show the new states.

Fill every row of the report, including items that never started:

```md
## Lead report: <goal>

Project `<project id>` on `OWNER/REPO` · <k> items · <m> workers started · <p> PRs merged · <q> open · <r> escalated

| Issue | Item | Worker | PR | Result |
| --- | --- | --- | --- | --- |
| #123 | <item> | work-123 | #140 merged | done |
| #124 | <item> | work-124 | #141 open, CI red (<test>) | needs:founder: <question> |
| #125 | <item> | work-125 | – | not started: folder-trust prompt (see below) |
| #126 | <item> | work-126 | #142 open, green | awaiting review (review policy) |

### Needs a person
- <decision or unblock, with the issue link>

### Not verified / limitations
- <what no worker proved, platforms not tested, reruns used>
```

Keep private details (local paths outside the repository, session ids,
account ids, prompt text) out of public comments; they belong in your session
output only.

## 7. The worker brief

Fill `<REPO>`, `<N>`, `<BASE>` (the default branch), `<CHECKS>` (the
project's lint, typecheck and test commands) and `<MERGE>` (the text for the
merge policy from §1, below). Change nothing else.

`<MERGE>` under the **auto** policy:

```text
When it is green, merge with `gh pr merge <pr> --squash --delete-branch` if the repository's rules let you; otherwise leave it open and say so.
```

`<MERGE>` under the **review** policy:

```text
When it is green, do not merge: a person reviews every pull request first and the lead merges it after approval. Comment on the pull request that it is ready for review and leave it open. If the lead sends you review feedback, address it, push and wait for CI again; still do not merge, approve or label it yourself.
```

The brief:

```text
You are a worker agent started by a Dure lead for <REPO> issue #<N>. Work autonomously; nobody will answer questions in this terminal, and the lead reads your pull request and issue comments, not your screen. Repository rules in AGENTS.md and CONTRIBUTING.md apply.

1. Read the issue: `gh issue view <N> --repo <REPO> --comments`. It defines the scope and acceptance; do not widen it. Post one short comment that you have started and name your branch.
2. You are already in an isolated worktree on your own branch (`agent/work-<N>`), created from <BASE>. Never check out branches elsewhere, never use bare `git stash` / `git stash pop`, never touch other worktrees or the primary checkout.
3. For a bug, reproduce it first (a fixture, a unit test, or the repository's QA runners with disposable HOME-style isolation; never a person's live app or data). Keep the change focused; add tests at the level where the behavior lives; run the project's lint, typecheck and the test files you touched. Project checks: <CHECKS>.
4. Commit in English, conventional style (`fix(scope): …`, `feat(scope): …`), with the attribution lines the repository asks for. Push the branch and open a pull request against <BASE> with `gh pr create`: body = root cause or context, the change, tests run, what was not verified, and `Closes #<N>`.
5. Wait for CI: `gh pr checks <pr> --watch`. If it fails only on a test the repository lists as known-flaky, rerun the failed jobs once (`gh run rerun <run> --failed`). If it fails for a real reason, fix it and push. <MERGE>
6. If the issue needs a product decision, is a duplicate, or is not this repository's problem, do not guess: comment the question, add the label `needs:founder` to the issue, leave your work as a draft pull request if there is any, and stop.
7. Finish with a short comment on the issue naming the pull request, what changed and what was not verified. Then stop; do not start other work. Keep private paths, session ids and credentials out of every public comment.
```

## If `dure` does not recognize something here

This file installs separately from the binary, so it can be older or newer than
the `dure` on PATH. When a command or flag named above is rejected as unknown, that
mismatch is the likely cause — do not invent a different spelling, and do not
abandon the task silently. Read the real grammar from `dure <command> --help`,
check `dure skills status` for whether this skill reports `outdated`, and run
`dure skills install --global` to bring every shipped skill back in step with
the installed CLI.
