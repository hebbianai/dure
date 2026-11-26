# Push service

The push service turns a paired computer's signed request into an Apple push
alert with fixed text and identifiers only. Its source is
[`mobile/push-service`](../../mobile/push-service/). The official instance is
the Fly app `dure-push` in `nrt`, reached at `https://push.dureai.dev/` (a
CNAME to `dure-push.fly.dev`). It runs as exactly one machine with one volume.

## Who may send

Every request is signed by the computer's Hub certificate (P-256).

- **v2** (`/v2/register`, `/v2/send`): the request carries a grant that the
  phone signed with its per-install alert key, naming exactly this computer's
  fingerprint, the token, the environment and the preference. Before a key may
  send to a token, the service sends that token one challenge alert, and the
  phone signs its nonce back in its next grant. That proof creates a
  **binding** (token → key), the only thing the service writes to disk.
- **v1** (`/v1/register`, `/v1/send`): computers listed in
  `DURE_PUSH_HUB_FINGERPRINTS`, kept for the transition. Unsetting it ends v1.

Until a request is proven to come from the bound key, every refusal is a bare
`403 {"status":"refused"}`.

| Answer | Meaning |
| --- | --- |
| `200 registered` | The grant's key is bound to the token; the binding was renewed or created. |
| `202 challenge_sent` + `key` | The key is not bound: a challenge alert went to the token (at most once a minute). The answer is the same whether the token is unbound or bound to another key. |
| `202 accepted`, `200 duplicate`, `200 filtered` | The alert was handed to APNs, was already delivered within the hour, or the preference excludes its kind. |
| `403 grant_expired`, `403 grant_superseded` | The bound key's grant has ended (or is dated more than 5 minutes ahead), or the phone has since raised its epoch. |
| `410 unregistered` | APNs will never deliver to the token; on v2 the binding is dropped. |
| `422 unsupported_kind` | A bound key's computer sent an alert kind this service does not send. |
| `429 rate_limited` (with `Retry-After`), `429 busy` | A limit below, or 16 deliveries in flight. |
| `502 unavailable`, `503 unavailable`, `503 capacity` | APNs failed, the binding could not be written, or the store is full. |

`GET /health` answers `{"status":"ready","api":[1,2],"kinds":["approval","done","input","message"]}`,
with `api` `[2]` once the allowlist is unset. Fly's check reads only the status
code.

## Alerts

An alert is fixed text in the phone's language plus identifiers in its `dure`
object: the agent a tap opens (`session`), the `kind`, and the computer that
raised it (`hub`). Some kinds carry one more identifier, and only with an
agent:

| Kind | Text (en) | Also carries | Category that identifier adds |
| --- | --- | --- | --- |
| `approval` | An agent is waiting for your approval. | `approval` (`attentionId`, `terminalEpoch`) | `dure.approval` |
| `done` | An agent finished its turn. | `reply` (`terminalEpoch`) | `dure.reply` |
| `input` | An agent is waiting for your answer. | none | none |
| `message` | An agent sent you a message. | `notice` | none |

`message` is an agent's `dure notify`. Its text stays on the computer: the
service only sees `notice`, the opaque id the computer keeps the text under,
for the phone to ask that computer for the text. A `notice` on another kind,
or without an agent, is refused. A phone set to approvals only gets
`200 filtered` for every kind but `approval`.

## Limits

Keyed by the client address (`Fly-Client-IP`; an IPv6 address by its /64), before anything is verified:
30 failures a minute, 30 registers a minute and 10 challenge starts an hour.
All challenges together: 1,200 an hour. After verification: 10 registers a
minute per computer; per token 3 challenges an hour and 10 a day, and 300
alerts a day of which the last 50 are kept for approvals; per binding and
computer a burst of 10 alerts refilling one a minute. The numbers live in
[`limits.mjs`](../../mobile/push-service/limits.mjs).

## Configuration

[`fly.toml`](../../mobile/push-service/fly.toml) sets `PORT`,
`DURE_APNS_KEY_FILE`, `DURE_PUSH_STATE_DIR=/data`, `DURE_PUSH_AUDIENCE` (every
base URL a desktop may name in a signed v2 request) and
`DURE_PUSH_CLIENT_IP_HEADER=fly-client-ip`.

Secrets, by name: `DURE_APNS_KEY_BASE64` (the APNs provider key, which Fly
writes to `DURE_APNS_KEY_FILE`), `DURE_APNS_KEY_ID`, `DURE_APNS_TEAM_ID` and,
during the transition, `DURE_PUSH_HUB_FINGERPRINTS` (comma-separated,
`SHA256:` fingerprints with or without the trailing `=`). No other secret
exists: grants and proofs use phone keys.

The image starts as root only to hand `/data` and the key file to `node`, then
runs the service with `setpriv` as `node` with no supplementary groups.
`main.mjs` refuses to run as root, and refuses to start without a writable
`DURE_PUSH_STATE_DIR` or without `DURE_PUSH_AUDIENCE`. Its errors name fields,
never values.

## State and the one-machine rule

`/data` (volume `dure_push_state`) holds `bindings.log`, an append-only journal
fsynced per change, and `bindings.json`, a snapshot rewritten through a staged
file at startup and whenever the journal outgrows the live records. A record
is a one-way hash of the environment and token, the phone's public key, the
epoch, the bind time and when the latest grant ends; it is pruned 30 days
after that. The store holds at most 100,000 records and logs
`Push bindings reached 80% of capacity` on the way there.

A torn final journal line is ignored. Any other unreadable file is moved aside
as `*.corrupt-<ms>`, the service starts empty and logs
`Push binding store was unreadable; moved it aside and started empty`. Losing
the store pauses alerts until each phone next opens Dure and proves receipt
again; it opens no takeover window, because every binding needs a new proof.

Pending challenges, limits and delivery dedupe live in the machine's memory.
A second machine would split them and the bindings. `fly deploy` can add one,
so after every deploy run `fly scale count 1 -a dure-push --yes` and check
`fly status -a dure-push`.

## Deploy

Deploy from the repository root, because the Dockerfile copies paths relative
to it.

First deploy of v2 only:

1. `fly status -a dure-push`, `fly secrets list -a dure-push` and
   `fly machine list -a dure-push`.
2. The hostname: a DNS CNAME `push.dureai.dev` → `dure-push.fly.dev`, then
   `fly certs add push.dureai.dev -a dure-push`, and wait until
   `fly certs show push.dureai.dev -a dure-push` reports it issued.
3. Create exactly one volume: `fly volumes create dure_push_state -a dure-push -r nrt -s 1 --yes`,
   and check `fly volumes list -a dure-push`.

Every deploy:

1. `fly deploy -c mobile/push-service/fly.toml .`. If flyctl will not attach
   the volume to a machine created before the mount existed, run
   `fly machine destroy <id> -a dure-push --force` and deploy again; the
   service before v2 holds no state.
2. `fly scale count 1 -a dure-push --yes`, then `fly status -a dure-push`:
   one machine, with the volume attached.

### A new alert kind goes out before the desktop that sends it

A desktop and this service update on their own schedules. Until the deployed
service lists a kind in `/health` `kinds`, a v2 alert of that kind answers
`422 unsupported_kind` and a v1 alert a bare `403`. So the service change that
adds a kind is deployed first, and the desktop change that sends it merges only
once `/health` lists the kind. For `message`, the service (#721 N2) is deployed
before the desktop's phone delivery of `dure notify` (#721 N3) merges.

## Smoke checks

- `curl -fsS https://push.dureai.dev/health` returns the `/health` answer
  above.
- `fly logs -a dure-push` shows `Dure push service listening on port 8080`
  and no `Push service configuration failed`.
- The service runs as `node` (uid 1000, no supplementary groups; the slim
  image has no `ps`):
  `fly ssh console -a dure-push -C "sh -c 'grep -H -E \"^(Uid|Groups)\" /proc/[0-9]*/status'"`.
  `fly ssh console -a dure-push -C "ls -ln /data /app/apns-key.p8"` shows
  `/data` and its files owned by 1000 with modes `0700`/`0600`, and the key
  file `0400`.
- An allowlisted maintainer computer still delivers over `/v1`.

## Rollback

`fly releases -a dure-push --image` lists the earlier images. Redeploy one
with `fly deploy -c mobile/push-service/fly.toml . --image <image-ref>`, then
check `fly status` and `/health`. The volume stays attached; an image from
before v2 ignores it, and needs `DURE_PUSH_HUB_FINGERPRINTS` set.

## Ending v1

Once a phone build that sends grants has been on the App Store for about two
weeks and a desktop release that sends v2 is out, a maintainer decides to run
`fly secrets unset DURE_PUSH_HUB_FINGERPRINTS -a dure-push`. Fly restarts the
machine, `/v1/*` answers 403 and `/health` lists `api` `[2]`. A follow-up
change then removes the v1 code from the service and the desktop.

## Ongoing

After every deploy, confirm one machine with `fly status -a dure-push`. Check
volume snapshots with `fly volumes snapshots list <volume-id>`; they shorten an
outage after a volume loss but are not needed for safety.
