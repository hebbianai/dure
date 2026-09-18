import { browserSnapshotOptions } from "./browser-snapshot.mjs";
import { BrowserCommandError } from "./browser-command-error.mjs";
import { implicitBrowserSessionController, resolveBrowserSessionController, prepareBrowserSessionControl } from "./browser-session-control.mjs";
import { parseBrowserArguments } from "./browser-arguments.mjs";
import { normalizeBrowserExec } from "./browser-exec.mjs";
import { browserLaunchScripts } from "./browser-init-scripts.mjs";
import { browserLaunchFeatures, browserReact } from "./browser-react.mjs";
import { browserInterception, performBrowserInterception, interceptionOptions } from "./browser-interception.mjs";
import { browserNetworkCapture, performBrowserNetworkCapture } from "./browser-network-capture.mjs";
import { browserNetworkQuery, networkQueryOptions, projectBrowserNetwork } from "./browser-network-query.mjs";
import { browserNetworkHistory, performBrowserNetworkHistory } from "./browser-network-history.mjs";
import { browserRecording, performBrowserRecording } from "./browser-recording.mjs";
import { browserTracing, performBrowserTracing } from "./browser-tracing.mjs";
import { encodeRef, target } from "./browser-reference.mjs";
import { browserQuery } from "./browser-query.mjs";
import { browserWait } from "./browser-wait.mjs";
import { browserFind } from "./browser-find.mjs";
import { browserData } from "./browser-data.mjs";
import { browserClipboard } from "./browser-clipboard.mjs";
import { browserEnvironment } from "./browser-environment.mjs";
import { browserMouse } from "./browser-mouse.mjs";
import { browserProfiles } from "./browser-profiles.mjs";
import { browserTabRows, allBrowserTabs, browserTabsWithProfiles, browserTabLabel, browserTabWithLabel } from "./browser-tabs.mjs";
import { browserConsole, performBrowserConsole } from "./browser-console.mjs";
import { browserActionAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";
import { browserDiff } from "./browser-diff.mjs";
import { browserDialog, performBrowserDialog } from "./browser-dialog.mjs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { downloadBrowserArtifact } from "./browser-artifact.mjs";
import { browserStateEncryptionKey, browserStateInput } from "./browser-state.mjs";
import { collectBrowserStateFiles, defaultBrowserStateOutput } from "./browser-state-files.mjs";
import { stageBrowserUploadBytes, stageBrowserUploads } from "./browser-upload.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { browserResourceSelection, browserCatalogResource, assertBrowserResource, selectBrowserResource } from "./browser-resource-target.mjs";

export const BROWSER_HELP = `Dure browser
Usage:
  dure browser runtime install|status
  dure browser open-url URL [--resource ID] [--space ID|NAME] [--profile ID] [--controller ID --epoch EPOCH]
  dure browser exec [RESOURCE] --command COMMAND [--page PAGE] [--controller ID --epoch EPOCH]
  dure browser create [--profile ID] [--init-script FILE]... [--enable react-devtools] [--idempotency-key KEY]
  dure browser list
  dure browser use RESOURCE [--idempotency-key KEY]
  dure browser tab profile list
  dure browser tab profile create --label NAME [--scope isolated|imported] [--no-ua-spoof] [--idempotency-key KEY]
  dure browser tab profile show RESOURCE --page ID
  dure browser tab profile set RESOURCE --profile ID --page ID --controller ID --epoch EPOCH [--idempotency-key KEY]
  dure browser tab profile use-default RESOURCE --page ID --controller ID --epoch EPOCH [--idempotency-key KEY]
  dure browser tab profile clone RESOURCE --profile ID --page ID --controller ID --epoch EPOCH [--idempotency-key KEY]
  dure browser tab profile delete --profile ID [--idempotency-key KEY]
  dure browser show RESOURCE
  dure browser tab list [RESOURCE] [--all] [--show-profile]
  dure browser tab current [RESOURCE] [--all]
  dure browser tab show RESOURCE --page PAGE
  dure browser tab create RESOURCE [URL] --controller ID --epoch EPOCH [--page PAGE] [--profile ID]
  dure browser tab switch RESOURCE --page PAGE|--index INDEX --controller ID --epoch EPOCH [--focus [--space ID|NAME]]
  dure browser tab close RESOURCE [--page PAGE|--index INDEX] --controller ID --epoch EPOCH
  dure browser dialog RESOURCE status --page PAGE
  dure browser dialog RESOURCE accept [TEXT] --page PAGE --controller ID --epoch EPOCH
  dure browser dialog RESOURCE dismiss --page PAGE --controller ID --epoch EPOCH
  dure browser network RESOURCE [--page PAGE] [--filter TEXT] [--type CSV] [--method METHOD] [--status CODE|2xx|200-299] [--limit N]
  dure browser network RESOURCE clear --controller ID --epoch N [--page PAGE]
  dure browser network RESOURCE request SEQUENCE [--page PAGE] [--output PATH]
  dure browser set RESOURCE credentials USER PASSWORD --page PAGE --controller ID --epoch EPOCH
  dure browser set RESOURCE credentials --user USER --pass PASSWORD --page PAGE --controller ID --epoch EPOCH
  dure browser set RESOURCE credentials reset --page PAGE --controller ID --epoch EPOCH
  dure browser intercept RESOURCE enable --page PAGE --controller ID --epoch EPOCH [--patterns GLOB,...] [--abort | --body TEXT]
  dure browser intercept RESOURCE disable --page PAGE --controller ID --epoch EPOCH
  dure browser intercept RESOURCE list --page PAGE
  dure browser capture RESOURCE start --page PAGE --controller ID --epoch EPOCH
  dure browser capture RESOURCE stop --page PAGE --controller ID --epoch EPOCH [--output FILE.har]
  dure browser capture RESOURCE status --page PAGE
  dure browser console RESOURCE --page PAGE [--limit N] [--before SEQUENCE]
  dure browser console RESOURCE clear --page PAGE --controller ID --epoch EPOCH
  dure browser errors RESOURCE [--page PAGE] [--limit N] [--before SEQUENCE]
  dure browser errors RESOURCE clear [--page PAGE] --controller ID --epoch EPOCH
  dure browser intercept RESOURCE enable [PATTERN] [--patterns CSV] [--abort | --body TEXT] --controller ID --epoch EPOCH
  dure browser intercept RESOURCE remove PATTERN --controller ID --epoch EPOCH
  dure browser cookie RESOURCE get [--url URL] --page PAGE
  dure browser cookie RESOURCE set NAME VALUE --page PAGE --controller ID --epoch EPOCH [--url URL] [--domain DOMAIN] [--path PATH] [--secure] [--http-only] [--same-site Strict|Lax|None] [--expires SECONDS]
  dure browser cookie RESOURCE delete NAME --page PAGE --controller ID --epoch EPOCH [--url URL] [--domain DOMAIN] [--path PATH]
  dure browser cookie RESOURCE set --curl FILE --page PAGE --controller ID --epoch EPOCH [--url URL] [--domain DOMAIN]
  dure browser cookie RESOURCE clear --page PAGE --controller ID --epoch EPOCH
  dure browser storage RESOURCE local|session [get [KEY]] --page PAGE
  dure browser storage RESOURCE local|session set KEY VALUE --page PAGE --controller ID --epoch EPOCH
  dure browser storage RESOURCE local|session clear --page PAGE --controller ID --epoch EPOCH
  dure browser state RESOURCE save [FILE.json] --page PAGE --controller ID --epoch EPOCH
  dure browser state RESOURCE load FILE.json --page PAGE --controller ID --epoch EPOCH
  dure browser clipboard RESOURCE read --page PAGE --controller ID --epoch EPOCH
  dure browser clipboard RESOURCE write TEXT --page PAGE --controller ID --epoch EPOCH
  dure browser clipboard RESOURCE write --text TEXT --page PAGE --controller ID --epoch EPOCH
  dure browser clipboard RESOURCE copy|paste --page PAGE --controller ID --epoch EPOCH
  dure browser viewport RESOURCE WIDTH HEIGHT --page PAGE --controller ID --epoch EPOCH [--scale N] [--mobile]
  dure browser viewport RESOURCE reset --page PAGE --controller ID --epoch EPOCH
  dure browser device RESOURCE NAME|reset --page PAGE --controller ID --epoch EPOCH
  dure browser media RESOURCE screen|print|reset --page PAGE --controller ID --epoch EPOCH [--color-scheme light|dark|no-preference] [--reduced-motion reduce|no-preference]
  dure browser geo RESOURCE LATITUDE LONGITUDE --page PAGE --controller ID --epoch EPOCH [--accuracy METERS]
  dure browser geo RESOURCE reset|unavailable --page PAGE --controller ID --epoch EPOCH
  dure browser offline RESOURCE on|off --page PAGE --controller ID --epoch EPOCH
  dure browser headers RESOURCE JSON_OBJECT|reset --page PAGE --controller ID --epoch EPOCH
  dure browser permission RESOURCE geolocation|clipboard-read|clipboard-write granted|denied|prompt ORIGIN --page PAGE --controller ID --epoch EPOCH
  dure browser control RESOURCE --controller ID
  dure browser wait RESOURCE selector SELECTOR --page PAGE [--state visible|hidden|attached|detached] [--timeout MS]
  dure browser wait RESOURCE text|url VALUE --page PAGE [--timeout MS]
  dure browser wait RESOURCE load load|domcontentloaded|networkidle --page PAGE [--timeout MS]
  dure browser wait RESOURCE duration MS --page PAGE
  dure browser wait RESOURCE function EXPRESSION --page PAGE --controller ID --epoch EPOCH [--timeout MS]
  dure browser find RESOURCE role|text|label|placeholder|alt|title|testid VALUE click|check|uncheck|focus|hover|text --page PAGE [--exact] [--name NAME]
  dure browser find RESOURCE LOCATOR VALUE fill|type TEXT --page PAGE --controller ID --epoch EPOCH
  dure browser find RESOURCE first|last|nth SELECTOR ACTION --page PAGE [--index N]
  dure browser get RESOURCE text|html|value|box|styles SELECTOR_OR_REF [--page PAGE]
  dure browser get RESOURCE attr SELECTOR_OR_REF NAME [--page PAGE]
  dure browser get RESOURCE count SELECTOR --page PAGE
  dure browser get RESOURCE url|title --page PAGE
  dure browser is RESOURCE visible|enabled|checked SELECTOR_OR_REF [--page PAGE]
  dure browser snapshot RESOURCE --page PAGE [--interactive] [--compact] [--depth N] [--selector CSS] [--urls] [--cursor]
  dure browser screenshot|full-screenshot RESOURCE --page PAGE [--output FILE] [--format png|jpeg] [--quality 0..100] [--element SELECTOR_OR_REF] [--annotate]
  dure browser pdf RESOURCE --page PAGE --controller ID --epoch EPOCH [--output FILE.pdf]
  dure browser record RESOURCE start|restart FILE.mp4|FILE.webm [URL] --controller ID --epoch EPOCH [--page PAGE]
  dure browser record RESOURCE stop --controller ID --epoch EPOCH [--page PAGE] [--output FILE]
  dure browser record RESOURCE status [--page PAGE]
  dure browser trace RESOURCE start [--scope task|browser] --controller ID --epoch EPOCH [--page PAGE]
  dure browser profiler RESOURCE start [--categories LIST] [--scope task|browser] --controller ID --epoch EPOCH [--page PAGE]
  dure browser trace|profiler RESOURCE stop [FILE.json] --controller ID --epoch EPOCH [--page PAGE | --recording START_OPERATION]
  dure browser trace|profiler RESOURCE status [--page PAGE]
  dure browser vitals|web-vitals RESOURCE [URL] --controller ID --epoch EPOCH [--page PAGE]
  dure browser diff RESOURCE snapshot [--baseline FILE_OR_TEXT] [--selector CSS] [--compact] [--depth N]
  dure browser diff RESOURCE screenshot --baseline FILE [--output PNG] [--threshold N] [--selector CSS_OR_REF] [--full]
  dure browser react RESOURCE tree|inspect ID|renders [start|stop]|suspense [--only-dynamic] --controller ID --epoch EPOCH
  dure browser artifact OPERATION_ID [--output FILE]
  dure browser download RESOURCE SELECTOR_OR_REF --output FILE --controller ID --epoch EPOCH [--page PAGE] [--timeout MS]
  dure browser upload RESOURCE SELECTOR_OR_REF FILE... --controller ID --epoch EPOCH [--page PAGE]
  dure browser goto RESOURCE URL --page PAGE --controller ID --epoch EPOCH
  dure browser pushstate RESOURCE URL --page PAGE --controller ID --epoch EPOCH
  dure browser init-script RESOURCE add SCRIPT --controller ID --epoch EPOCH [--page PAGE]
  dure browser init-script RESOURCE remove IDENTIFIER --controller ID --epoch EPOCH [--page PAGE]
  dure browser back|forward|reload RESOURCE --page PAGE --controller ID --epoch EPOCH
  dure browser dblclick|check|uncheck|focus|clear|select-all|hover|scrollintoview RESOURCE SELECTOR_OR_REF --controller ID --epoch EPOCH [--page PAGE]
  dure browser highlight RESOURCE SELECTOR_OR_REF --controller ID --epoch EPOCH [--page PAGE]
  dure browser select RESOURCE SELECTOR_OR_REF VALUE --controller ID --epoch EPOCH [--page PAGE]
  dure browser drag RESOURCE SOURCE_SELECTOR_OR_REF TARGET_SELECTOR_OR_REF --controller ID --epoch EPOCH [--page PAGE]
  dure browser scroll RESOURCE up|down|left|right PIXELS --page PAGE --controller ID --epoch EPOCH
  dure browser click RESOURCE SELECTOR_OR_REF --controller ID --epoch EPOCH [--page PAGE]
  dure browser fill RESOURCE SELECTOR_OR_REF TEXT --controller ID --epoch EPOCH [--page PAGE]
  dure browser inserttext RESOURCE TEXT --page PAGE --controller ID --epoch EPOCH
  dure browser keyboard RESOURCE type TEXT --page PAGE --controller ID --epoch EPOCH
  dure browser key RESOURCE KEY_OR_CHORD --page PAGE --controller ID --epoch EPOCH
  dure browser keydown|keyup RESOURCE KEY --page PAGE --controller ID --epoch EPOCH
  dure browser tap RESOURCE TARGET --page PAGE --controller ID --epoch EPOCH
  dure browser swipe RESOURCE up|down|left|right [DISTANCE] --page PAGE --controller ID --epoch EPOCH
  dure browser window new RESOURCE --controller ID --epoch EPOCH
  dure browser mouse RESOURCE move X Y --page PAGE --controller ID --epoch EPOCH
  dure browser mouse RESOURCE down|up [left|right|middle|back|forward] --page PAGE --controller ID --epoch EPOCH
  dure browser mouse RESOURCE wheel DY [DX] --page PAGE --controller ID --epoch EPOCH
  dure browser eval RESOURCE SCRIPT --page PAGE --controller ID --epoch EPOCH
  dure browser frame RESOURCE SELECTOR_OR_REF|main --controller ID --epoch EPOCH [--page PAGE]
  dure browser tab-new RESOURCE URL --page PAGE --controller ID --epoch EPOCH
  dure browser tab-switch RESOURCE --page PAGE --controller ID --epoch EPOCH
  dure browser tab-close RESOURCE --page PAGE --controller ID --epoch EPOCH
  dure browser disconnect RESOURCE --controller ID --epoch EPOCH
  dure browser close RESOURCE [--idempotency-key KEY]
  dure browser receipt OPERATION_ID

All commands accept --backend ID and --json. Results are structured JSON.
Inside a Hmux session, controller/epoch may be omitted: the selected backend
must verify the exact live session generation. The CLI uses that session's
controller and the currently observed lease. An unowned Browser is claimed once;
snapshot claims before creating element references. A Browser controlled by
another session or a person stays theirs: input refuses until control is returned.
Use "dure browser control RESOURCE" for an explicit handoff to your session.
Passive reads remain available; snapshot while another controller owns the
Browser does not transfer control. Outside Hmux, supply --controller and --epoch.
Explicit flags keep their exact meaning, including stale-epoch refusal.
Results include session_controller and, when claiming, its control_operation_id.
After response loss, inspect that control receipt and the input operation_id
separately before continuing. Environment values are lookup hints; backend
authentication and Host control still authorize the operation. Remote selection
must verify the same session on that backend; local hints do not grant remote control.
open-url creates an HTTP(S) tab in the selected Browser and requests its Browser
panel in the invoking pane's Space, or --space. It checks the mounted client
before creation. A failed later presentation retains the runtime receipt; read
it with "receipt OPERATION_ID" instead of creating another tab. A requested
presentation does not confirm a decoded frame or foreground window focus.

tab switch --focus uses this same presentation path after the Host switches the
requested tab. Pane activation stays within the chosen Space. A later display
failure preserves the successful switch result and operation ID.

Resource commands also accept --resource ID instead of positional RESOURCE:
  dure browser get --resource ID value input
  dure browser tab list --resource ID
Named arguments can replace positional action values, for example:
  dure browser get --what value --element input
  dure browser click --element button --controller ID --epoch EPOCH
  dure browser fill --element input --value "Hello" --controller ID --epoch EPOCH
  dure browser goto --url https://example.com --controller ID --epoch EPOCH
  dure browser scroll --direction down [--amount PIXELS] --controller ID --epoch EPOCH
  dure browser wait --selector input --state visible --timeout 10000
  dure browser cookie set --name session --value "" --controller ID --epoch EPOCH
  dure browser storage local get --key session
  dure browser upload --element input --files one.txt,two.txt --controller ID --epoch EPOCH
  dure browser download --selector a --path file.zip --controller ID --epoch EPOCH
Use named or positional action values in one command, without mixing them.
Named commands and commands with no action values, such as snapshot or tab list,
default to the selected Browser on the chosen backend, regardless of the current
directory or worktree. Tab profile commands also require --page for this default.
The same controller lease and operation recovery rules apply to both syntaxes.
An encoded @br1 snapshot reference supplies its own resource for get/is and
element input commands, for example dure browser get value @br1.REFERENCE or
dure browser fill @br1.REFERENCE TEXT --controller ID --epoch EPOCH.
The original resource generation, page and document remain bound to the reference.
It does not select a backend or acquire controller authority.
Use --current in place of RESOURCE for positional commands. Named commands use the
selected Browser, for example:
  dure browser get --what url
  dure browser fill --element input --value "Hello" --controller ID --epoch EPOCH
Use "dure browser use RESOURCE" to select the default Browser. New Browsers become
selected; closing the selected Browser clears it. Viewing another Browser does
not select it. Missing selection requires an explicit Browser choice. This lookup
neither creates a Browser nor acquires control. Existing references retain their
own page/document identity and must match the selected resource.
Create/list use the shared browser collection on the selected local or remote
backend. Browser storage is independent of project and worktree directories.
Tab list --all lists every Browser resource on that backend; active marks the
current page within each resource. This read never changes Browser or page
selection. --show-profile includes the saved profile_label. Enumeration has one
45-second deadline; a failed observation returns an error instead of a partial list.
Tab current --all returns the first resource-current tab in catalog order, not OS focus.
Snapshots include cursor, mouse-listener, focusable and editable elements.
The --cursor flag is accepted for native command compatibility; discovery also
runs for default snapshots.

Use the controller epoch returned by control; snapshot refs carry their original
page and document. Except for tab show, tab switch and tab profile, page commands
use the current browser tab when --page is omitted. If no tab is selected,
provide --page. Get/is queries need no controller. Select a different page
with tab-switch before querying it or taking its snapshot.
Diff snapshot uses the same page and reference lifecycle as snapshot and needs
no controller. --baseline reads a UTF-8 file relative to the CLI's working
directory; if the path does not exist, its value is literal text. Omitting it
compares against empty text. result.data.diff contains the unified diff and
addition, removal and unchanged line counts. Baselines accept up to 1 MiB;
the existing snapshot response limit also includes the comparison result.
Diff screenshot compares a caller-local image with the current page or selector.
--threshold accepts 0 through 1 (default 0.1). --output writes a PNG only when
pixels differ; equal images or differing dimensions preserve existing output.
Use receipt OPERATION_ID and artifact OPERATION_ID to recover a completed
comparison and its optional image after a lost response.
Mutations accept --idempotency-key KEY. After response loss, read receipt and
show; a repeated operation never repeats browser input.
Keyboard type and find type insert Unicode characters individually, using Tab
and Enter for tab and line-break characters. Inserttext and direct type --input
insert the whole string in one operation.
Place options before -- to pass literal values such as --help after it.
Value options also accept --name=value, including empty or option-like values
such as --value=--help. Duplicate options, including aliases, are rejected.
Values that match a supported option must use --name=value so a missing value
cannot consume the next option. Invalid options include a correction hint.
Waits default to 10000 ms and accept up to 120000 ms. Fixed waits observe the
same page across navigation; function waits require control of their document.
Text waits include rendered text in open shadow roots of the selected frame.
Named scroll defaults to 300 CSS pixels when --amount is omitted. Named wait
selects one supplied condition in this order: --url, --load, --fn, --text,
--selector. Other conditions are ignored, including function expressions;
--state applies only when the selected condition is --selector. --timeout alone
performs a fixed wait. A bare wait requires a condition or duration.
Find mutations require --controller and --epoch; find text is an observation.
Captures and mutations accept --idempotency-key. Receipt includes a saved result
when available; artifact downloads its original file without repeating capture
or print, including after the browser closes. PDF requires control because page
print handlers can run. Image captures need no controller.
Screenshot, full-screenshot, PDF, capture stop and artifact return verified
result.base64 with result.mimeType when --output is omitted. An explicit output
path writes those same bytes atomically; failed transfers preserve an existing
file. Inline and file results share the 64 MiB artifact bound. A capture or
print is never repeated to recover its saved data: use artifact OPERATION_ID.
Upload reads files on the machine running this CLI. Up to 16 files and 64 MiB
per attachment are supported. File bytes are checked before page input; repeat
interrupted staging with the same files, and recover admitted input by receipt.
Download clicks the selected element once and saves the page's first download,
up to 64 MiB. Use receipt and artifact after response loss; the suggested site
filename never selects the local destination. The default timeout is 30000 ms.
Cookie and storage reads need no controller and do not execute page script.
Omitting the storage key reads all entries as data; an empty key reads that key.
Writes require control; storage keys and values accept up to 64 KiB each.
State load stages a local JSON file (up to 64 MiB), then merges its cookies and
localStorage/sessionStorage entries into the selected profile and page. It visits
each serialized origin and ends at the last one. Other keys remain. A redirect
cannot receive another origin's storage. Failures can leave partial changes;
recover the operation receipt before retrying.
State save requires control and exports profile cookies, visited origins' local
storage and the current origin's session storage without navigating the source
page. Other origins have empty sessionStorage in the portable format. FILE or
--output chooses a local destination. Omit the path to save in
$DURE_HOME/browser/states (default ~/.dure/browser/states), with a stable filename
for the selected resource. Separate resources have separate default files.
The existing verified artifact transfer publishes up to 64 MiB atomically.
Recover a lost response with receipt/artifact; do not repeat save.
DURE_BROWSER_ENCRYPTION_KEY encrypts state exports before backend persistence
and appends .enc to the destination. AGENT_BROWSER_ENCRYPTION_KEY is accepted
for interoperability; conflicting values are refused. The format is AES-256-GCM
with SHA-256 key derivation, a fresh 12-byte nonce and a 16-byte tag. Use a random
secret. Load stages ciphertext; a missing FILE.json can resolve FILE.json.enc
when a key is present. Authentication completes before any browser mutation.
Receipt/artifact recovery returns the original ciphertext without needing the
key or repeating save.
state list shows managed files; state show FILE reads a local JSON or encrypted
file, including its cookies and storage. state rename FILE NAME keeps encryption
and refuses overwrite. state clear [FILE] removes the selected file or all managed
state files; state clean [--days N] removes managed files older than N days
(default 30). List/clear/clean skip symlinks, directories and other file types.
File management runs on the invoking client without starting a browser or backend;
explicit paths resolve from the caller directory. Native exec accepts these commands.
Cookie delete matches the supplied name and scope; unrelated cookies remain.
Cookie clear removes all cookies in the selected page's saved profile, including
other origins and tabs sharing that profile. Other profiles and web storage remain.
Cookie set --curl FILE reads a local UTF-8 JSON name/value array, Cookie header,
or cURL export. It extracts cookie data without running cURL. The file's request
URL and JSON scope fields are ignored; --url/--domain supply scope, otherwise the
selected page URL applies. --domain supplies path /. Imports accept up to 64 KiB
and 256 cookies, with the same 64 KiB bound on the resulting batch. Read receipt
after response loss; do not repeat an import or clear to recover its result.
Clipboard read/write use the selected page's Clipboard API and require control.
Site permissions still apply; failures do not grant permission automatically.
Use permission RESOURCE clipboard-read|clipboard-write granted|denied|prompt
ORIGIN with the same controller to configure a specific HTTP(S) origin.
Write accepts up to 8 KiB of UTF-8 text, including empty text. Copy/paste use
the execution host's keyboard shortcut and honor the page's selection, focus
and cancelled key events. All clipboard operations require control and are
journaled; recover a lost response through receipt instead of replaying it.
The managed headless clipboard is separate from the desktop clipboard. Tabs
using the same profile share it; --backend selects the machine where it lives.
Network --limit N shows the latest N observed requests. Omit it to return the
full retained history. truncated reports this display limit; history_truncated
reports requests no longer retained by the runtime.
Network --filter matches a URL substring; --type accepts comma-separated request
types; --method ignores ASCII case; --status accepts a code, class or inclusive
range. These filters combine before --limit and also work in exec "network
requests". Filtering does not change pending counts, idle state or retained history.
Interception appends page HTTP request rules that survive navigation and control handoff.
All comma-separated URL patterns apply; * spans any characters, ? matches one,
and backslash escapes a literal. Rules without --abort or --body pass requests.
The first matching abort or response rule wins. --resource-type/--resource-types
accept comma-separated request types. WebSocket and preflight interception are
unavailable. Responses accept --status (default 200),
--content-type and --response-headers JSON. Disable removes every page rule.
List reports configured rules, availability and observed request history.
Requests are not held for a later manual decision. Observation loss makes rules unavailable.
Rules are a testing tool, not a network security boundary.
Credentials send HTTP Basic Authorization on the selected page, including later
navigations. Like headers, credentials replace the entire extra-header map;
credentials reset or headers reset clears it. The auth alias accepts the same
arguments. Empty passwords and UTF-8 text are supported. Preemptive Basic
authentication applies across origins visited by the selected page.
Network capture records HTTP metadata for the page across navigation.
Start/stop require control; status is passive. Use --output FILE.har to save stop's
result to a local file, or omit it for base64 HAR data. Capture also accepts
the prefix form, for example capture stop --controller ID
--epoch EPOCH. Without a resource selector it uses the backend's selected Browser.
The HAR retains bounded request/response headers, POST data and timing;
truncation is reported in the file. Recover a stopped recording through
artifact and its operation ID. Requests already in flight, including their
redirects, stay outside the new recording interval.
Console reads include console API calls and uncaught exceptions from the page,
its frames and workers, across navigation. Reading does not acquire control or
wait for a renderer blocked by a dialog. Clear requires control and is journaled.
The default limit is 100; next_before continues through older retained entries.
Errors reads only uncaught exceptions, filtering before the limit and cursor.
Errors clear removes those exceptions while preserving ordinary console calls,
including console.error. Native exec accepts errors and errors --clear.
History retains up to 1000 entries and 4 MiB per resource. Text and source URLs
are bounded to 64 KiB and 8 KiB; truncation is reported in the result and entry.
Exec "network route PATTERN" appends a page request rule; --abort blocks matches,
--body TEXT substitutes a response, and --resource-type CSV restricts request types.
Exec "network unroute PATTERN" removes every exact declaration of that pattern;
omit PATTERN to remove all rules. Other patterns and pages retain their rules.
Direct intercept enable PATTERN accepts one literal pattern, including commas;
--patterns CSV accepts several. Rule changes require control and survive navigation.
Viewport and media settings belong to the selected page and survive navigation.
Media screen/print replaces the media type and preferences; reset restores defaults.
Omit screen/print with --color-scheme or --reduced-motion to use the browser-default
media type and replace preferences. Exec "set media dark reduced-motion" uses
that behavior; dark wins over light, and omitted preferences use no-preference.
Viewport accepts up to 16 million scaled pixels, with scale 0.1 to 8. Mobile
emulates viewport behavior; it does not select a device or enable touch input.
Device selects page metrics and User-Agent together. Names: iPhone 12, 14, 15,
16, 16 Pro, 17; iPad (or iPad Air), iPad Pro; Pixel 5, 7, 9; Galaxy S21, S25.
Use the full name, for example "iPhone 15". Device reset clears both overrides;
viewport reset clears only metrics. Device emulation retains Chromium's engine
and does not enable touch input or emulate the named operating system.
Geo, offline and extra headers belong to the selected page. Headers replace the
entire extra-header set, including across origins; use reset to clear it.
Geo changes coordinates, not site permissions. Permission changes apply to the
specified HTTP(S) origin in the selected page's storage context. Regular tabs
share profile permissions; private windows keep their permissions separate.
Use geo unavailable to simulate missing position, or reset to restore the browser.
Environment commands also accept the form set RESOURCE COMMAND VALUES.
Tap sends touch events to the bound element. Swipe starts at CSS coordinates
(200, 400) and moves in the requested direction, using 300 CSS pixels by default.
Touch contacts drain on their original page before a controller handoff.
Window new selects a blank page with isolated cookies and storage. Its private
data is discarded when the last page in that context closes. Regular tab creation
uses the selected profile's default context.
Mouse coordinates and wheel deltas use CSS pixels. Hover, click, drag and mouse
commands share one pointer state. Changing pages or controllers releases held
buttons on the original page first; its release and click handlers can run.
Profile list/create manage saved profile settings on the selected backend.
Create defaults to isolated scope and a clean User-Agent setting; --no-ua-spoof
selects native. Imported scope does not read another browser's personal data.
Browser create selects the persistent default profile unless --profile ID is given.
Regular tabs using the same profile share cookies and local storage across
Browsers; different profiles have separate storage. Closing the last resource
preserves profile data. Private window data lasts only while its context is open.
Tab create --profile ID opens the requested URL directly in that saved profile,
preserving the source page. Omit --profile to use the current page's profile.
Creation uses one journaled action; use receipt OPERATION_ID after response loss.
Tab profile set RESOURCE --profile ID reloads the selected page in that profile while
preserving its page ID. Selecting the current profile leaves the document intact.
Tab profile clone opens the source URL in a new tab using the selected profile's
storage. The original tab stays open; its document state is not copied.
Profile delete closes that profile's tabs across resources and removes its stored
data. Default is protected. An interrupted deletion can be retried with a new
idempotency key.
Saved User-Agent policies are still in progress.
Exec accepts quoted native browser command strings and uses the same typed
operations, page identity, control and receipts as direct commands. It never runs
a shell. Native --cdp and --session flags are ignored; outer target and control
options remain authoritative. Engine commands without an integrated operation
(including connect) remain unsupported. Native close, quit and exit disconnect
the automation worker while preserving the pages; the next observation or action
reconnects to the selected owned page. Direct close retires the browser resource.
trace and profiler share one recording interval in the selected browser instance.
Task scope requires a browser that has only admitted this resource and prevents
other resources from joining during capture. --scope browser explicitly includes
all pages in that instance, including other Browsers and private windows.
Only the originating resource's current controller may stop and export it.
Stop writes JSON to the supplied client path or an owner-only browser-traces file
under DURE_HOME. Recover its immutable artifact with the stop operation receipt.
record <resource> start <output.mp4|output.webm> [url] begins a page recording.
record <resource> stop writes the completed video to that client's start path;
--output overrides the destination. Another client can use --output or receive
inline MP4 data. record restart <output.mp4|output.webm> [url] saves the previous recording
then starts another. record status reads the Host interval without control.
Recordings use silent AV1 video in MP4 or WebM, up to 1920×1080 at 10fps
and the 64MiB artifact bound. The stop destination selects the container.
Recover a stopped file with
artifact <stop-operation-id> --output <path>; do not repeat stop for recovery.
Frame SELECTOR_OR_REF selects an iframe inside the current document; frame main
returns to the page's main document. Queries, snapshots and element operations
use that selection, including nested and cross-origin frames. A removed frame
refuses document operations until an explicit reset. Main-document navigation
and explicit tab selection reset the frame; a controller handoff preserves it
and expires element references. Show/tab output includes the selected frame or
its missing-frame error. Screenshots and pointer coordinates retain the page's
full input surface. Native exec accepts the same frame SELECTOR_OR_REF|main forms.
Network request SEQUENCE reads the issued sequence from the request list, including
headers, POST data and the available response body. --output saves the complete
JSON record; large records use the existing artifact transfer. Recover a saved
result with artifact <operation-id> --output <path>. Network clear hides only the
selected page's history; pending requests and an active HAR interval continue.
Native exec accepts network request SEQUENCE and network requests --clear.
Native exec also accepts cookies get/set/clear and cookies set --curl FILE using
the same profile/import rules, storage reads with or without a key, network requests
and har start/stop, eval -b/--base64, and wait's short condition flags. Screenshot,
PDF, download and HAR output paths use the existing verified artifact transfer;
a failed transfer leaves an existing file intact. Screenshot --full/-f and
--screenshot-format png|jpeg, --screenshot-quality and --annotate are supported.
Element capture accepts a selector/reference and optional output path. Numbered
annotations return complete snapshot references; boxes use capture-relative CSS
coordinates with viewport.pixel_ratio for image pixels. PNG ignores JPEG quality.
Tab create --label NAME assigns a unique name within the selected resource,
including with --profile. Names start with an ASCII letter and contain up to 160
letters, digits, underscores or hyphens. Names survive navigation, profile changes
and control handoff; closing a tab frees its name. Tab switch/close/show --label
NAME resolves the name to the Host's exact page identity.
Exec tab PAGE_ID|NAME and tab close [PAGE_ID|NAME] use those same identities and
names. Native tab new accepts --label NAME before or after its optional URL.
An explicit outer --page must match. After closing the current pinned tab,
select a remaining page explicitly. Native positional indices remain unsupported.
Clipboard defaults to read; clipboard write joins its text
arguments. Clipboard copy/paste use the same admitted shortcuts as direct commands.
The managed installer and the remaining Orca command paths are still in progress.`;


const ELEMENT_COMMANDS = ["tap", "click", "fill", "dblclick", "select", "check", "uncheck", "focus", "clear", "select-all", "hover", "highlight", "scrollintoview"];

/** Normalize an explicit resource or complete element handle before resolving a
 * backend. A reference is parsed once and retains its original page identity. */
function normalizeResource(options) {
  const words = options.positional;
  const command = words[0];
  if (options.resource !== undefined) {
    if (!isDureDomainIdV1(options.resource) || ["create", "list", "receipt", "artifact"].includes(command)) throw new Error("browser_command_invalid");
    let index = command === "tab" ? 2 : 1;
    if (command === "tab" && words[1] === "profile") {
      if (!["show", "set", "clone", "use-default"].includes(words[2])) throw new Error("browser_command_invalid");
      index = 3;
    }
    words.splice(index, 0, options.resource);
    delete options.resource;
    return target;
  }
  let index = ["get", "is"].includes(command) ? 2
    : ELEMENT_COMMANDS.includes(command) || ["drag", "download", "upload", "frame", "screenshot", "full-screenshot"].includes(command) ? 1 : undefined;
  if (command === "drag" && words.length === 3 && !words[1]?.trimStart().startsWith("@")) index = 2;
  const token = words.length === 1 && options.captureElement !== undefined ? options.captureElement : words[index];
  if (typeof token !== "string" || !token.trimStart().startsWith("@")) return target;
  const parsed = target(token);
  const resource = parsed.reference.snapshot.page.resource.resource_id;
  if (!isDureDomainIdV1(resource)) throw new Error("browser_reference_invalid");
  words.splice(1, 0, resource);
  return (value) => value === token ? parsed : target(value);
}

export async function collectBrowserCommand({ args, resolveBackend, requestBackend = performBackendProfileRequest, cwd, sourceEnvironment, appControl }) {
  let operationId;
  let backend;
  let sessionController;
  try {
    const options = parseBrowserArguments(args);
    normalizeBrowserExec(options);
    if (["vitals", "web-vitals"].includes(options.positional[0]) && options.url !== undefined) {
      options.positional.push(options.url);
      delete options.url;
    }
    if (options.positional[0] === "window") {
      if (options.positional[1] !== "new") throw new Error("browser_window_invalid");
      options.positional.splice(0, 2, "window-new");
    }
    const stateFiles = await collectBrowserStateFiles(options, { environment: sourceEnvironment, cwd });
    if (stateFiles !== undefined) return stateFiles;
    if (options.days !== undefined) throw new Error("browser_command_invalid");
    if (options.positional[0] === "open-url") {
      const { collectBrowserOpenUrl } = await import("./browser-open-url.mjs");
      return await collectBrowserOpenUrl({ options, resolveBackend, requestBackend, cwd, sourceEnvironment, appControl, run: collectBrowserCommand });
    }
    if (options.positional[0] === "runtime") {
      if (options.positional.length !== 2 || !["install", "status"].includes(options.positional[1])
          || Object.keys(options).some((key) => !["positional", "backend"].includes(key))) throw new Error("browser_command_invalid");
      backend = await resolveBackend({ backend: options.backend, backendSpecified: options.backend !== undefined });
      if (!backend?.profile || backend.error) return { ok: false, error: backendRequestFailure(backend?.error, backend?.profile) };
      const reply = await requestBackend(backend.profile, {
        requestId: randomUUID(), operation: "browser.resource", requiredCapabilities: ["browser.resource.v1"],
        body: { kind: options.positional[1] === "install" ? "runtime_install" : "runtime_status" },
      }, backend.transportOptions);
      const result = reply.result;
      if (!["ready", "missing", "installing", "failed", "unsupported"].includes(result?.result?.state)) throw new Error("browser_response_invalid");
      return { ok: !["failed", "unsupported"].includes(result.result.state), ...result };
    }
    if (options.focus) {
      if (options.positional[0] !== "tab" || options.positional[1] !== "switch") throw new Error("browser_command_invalid");
      const { collectBrowserTabFocus } = await import("./browser-presentation.mjs");
      return await collectBrowserTabFocus({ options, resolveBackend, requestBackend, cwd, sourceEnvironment, appControl, run: collectBrowserCommand });
    }
    if (options.space !== undefined) throw new Error("browser_command_invalid");
    const implicitController = implicitBrowserSessionController(options, sourceEnvironment);
    const resourceSelection = browserResourceSelection(options);
    const elementTarget = normalizeResource(options);
    const tab = options.positional[0] === "tab" && options.positional[1] !== "profile" ? options.positional[1] : undefined;
    if (tab !== undefined) {
      const [, , resource, ...values] = options.positional;
      const mapped = { list: "tab-list", current: "tab-current", show: "tab-show", create: "tab-new", switch: "tab-switch", close: "tab-close" };
      if (!Object.hasOwn(mapped, tab) || (!resource && !resourceSelection.all)) throw new Error("browser_command_invalid");
      if (tab === "create") {
        if (values.length > 1 || (values.length && options.url !== undefined)) throw new Error("browser_command_invalid");
        options.positional = [mapped[tab], resource, values[0] ?? options.url ?? "about:blank"];
        delete options.url;
      } else options.positional = [mapped[tab], ...(resourceSelection.all ? [] : [resource]), ...values];
    }

    operationId = options.operationId ?? randomUUID();
    const [requestedCommand, requestedResourceId, ...values] = options.positional;
    const command = ({ type: "inserttext", keypress: "key", "web-vitals": "vitals" })[requestedCommand] ?? requestedCommand;
    const react = browserReact(command, values, options);
    const launchFeatures = browserLaunchFeatures(command, options.enabledFeatures, sourceEnvironment);
    const tracing = ["trace", "profiler"].includes(command) ? browserTracing(command, values, options, implicitController) : undefined;
    if (!tracing && (options.categories !== undefined || options.tracingRecording !== undefined)) throw new Error("browser_command_invalid");
    const diff = await browserDiff(command, values, options, cwd);
    const diffSnapshot = diff?.kind === "snapshot" ? diff.options : undefined;
    const diffScreenshot = diff?.kind === "screenshot" ? diff : undefined;
    const snapshotOptions = diff ? diffSnapshot : browserSnapshotOptions(command, options);
    if (options.showProfile && command !== "tab-list") throw new Error("browser_command_invalid");
    if (resourceSelection.all && Object.keys(options).some((key) => !["positional", "backend", "operationId", "showProfile"].includes(key))) throw new Error("browser_command_invalid");
    if (command === "use" && (!isDureDomainIdV1(requestedResourceId) || Object.keys(options).some((key) => !["positional", "backend", "operationId"].includes(key)))) throw new Error("browser_command_invalid");
    const profiles = command === "tab" && requestedResourceId === "profile" ? browserProfiles(values, options, operationId) : undefined;
    const tabLabel = options.label !== undefined && ["tab-new", "tab-switch", "tab-close", "tab-show"].includes(command) ? browserTabLabel(options.label) : undefined;
    const profileNewPage = command === "tab-new" && options.profileId !== undefined
      ? { kind: "profile_new_page", resource_id: requestedResourceId, profile_id: options.profileId, url: values[0], ...(tabLabel === undefined ? {} : { label: tabLabel }) } : undefined;
    const profileChange = profileNewPage ?? (["profile_set", "profile_clone"].includes(profiles?.kind) ? profiles : undefined);
    const profileShow = profiles?.kind === "profile_show" ? profiles : undefined;
    let resourceId = profileChange?.resource_id ?? profileShow?.resource_id ?? requestedResourceId;
    if (options.profileId !== undefined && ((command !== "create" && !profileChange && profiles?.kind !== "profile_delete") || !options.profileId.trim())) throw new Error("browser_command_invalid");
    if (!profiles && ((options.scope !== undefined && !tracing) || options.noUaSpoof !== undefined || options.label !== undefined && tabLabel === undefined)) throw new Error("browser_command_invalid");
    if (command !== "set" && (options.user !== undefined || options.pass !== undefined)) throw new Error("browser_command_invalid");
    if (command !== "clipboard" && options.text !== undefined) throw new Error("browser_command_invalid");
    const uploading = command === "upload";
    const stateLoading = command === "state" && values[0] === "load";
    const stateSaving = command === "state" && values[0] === "save";
    if (command === "state" && (!stateLoading && !stateSaving || stateLoading && (values.length !== 2 || !values[1] || options.output !== undefined) || stateSaving && (values.length > 2 || values[1] === "" || options.output === "" || values[1] !== undefined && options.output !== undefined))) throw new Error("browser_state_command_invalid");
    const stateEncryption = command === "state" ? browserStateEncryptionKey(sourceEnvironment ?? process.env) : undefined;
    if (stateSaving && (values[1] !== undefined || options.output !== undefined)) options.output = resolve(cwd ?? process.cwd(), values[1] ?? options.output) + (stateEncryption === undefined ? "" : ".enc");
    const downloading = command === "download";
    const downloadTimeout = Number(options.timeout ?? 30_000);
    if (downloading && (!Number.isSafeInteger(downloadTimeout) || downloadTimeout < 1 || downloadTimeout > 30_000)) throw new Error("browser_download_timeout_invalid");
    if (uploading && (values.length < 2 || values.length > 17)) throw new Error("browser_upload_files_invalid");
    const imageCapture = command === "screenshot" || command === "full-screenshot";
    if (!imageCapture && ["captureElement", "annotate", "quality"].some((key) => options[key] !== undefined)) throw new Error("browser_command_invalid");
    if (imageCapture && (values.length > 1 || (values.length && options.captureElement !== undefined))) throw new Error("browser_command_invalid");
    const captureTarget = diffScreenshot?.selector !== undefined ? elementTarget(diffScreenshot.selector) : imageCapture && (options.captureElement !== undefined || values.length) ? elementTarget(options.captureElement ?? values[0]) : undefined;
    const quality = options.quality === undefined ? undefined : Number(options.quality);
    if (quality !== undefined && (!/^(0|[1-9][0-9]{0,2})$/.test(options.quality) || quality > 100)) throw new Error("browser_capture_quality_invalid");
    const interception = command === "intercept" ? browserInterception(values, options, implicitController) : undefined;
    if (command !== "intercept" && interceptionOptions.some((key) => options[key] !== undefined && !(command === "network" && key === "status"))) throw new Error("browser_command_invalid");
    if (command !== "network" && networkQueryOptions.some((key) => options[key] !== undefined)) throw new Error("browser_command_invalid");
    const networkCapture = command === "capture" ? browserNetworkCapture(values, options, implicitController) : undefined;
    const recording = command === "record" ? browserRecording(values, options, implicitController) : undefined;
    const networkHistory = command === "network" ? browserNetworkHistory(values, options, implicitController) : undefined;
    const exportsFile = tracing?.action === "stop" || !!networkHistory?.sequence || ["stop", "restart"].includes(recording?.action) || networkCapture?.action === "stop" || imageCapture || diffScreenshot || command === "pdf" || command === "artifact" || downloading || stateSaving;
    if (options.format !== undefined && (!imageCapture || !["png", "jpeg"].includes(options.format))) throw new Error("browser_capture_format_invalid");
    if ((downloading || (exportsFile && options.output !== undefined)) && !options.output) throw new Error("browser_output_required");
    const tabIndex = options.index !== undefined && ["tab-switch", "tab-close"].includes(command) ? Number(options.index) : undefined;
    if (tabLabel !== undefined && options.index !== undefined) throw new Error("browser_command_invalid");
    if (tabIndex !== undefined && (!/^(0|[1-9][0-9]*)$/.test(options.index) || !Number.isSafeInteger(tabIndex) || tabIndex > 127)) throw new Error("browser_tab_index_invalid");
    if (command !== "find" && (options.exact || options.name !== undefined || (options.index !== undefined && tabIndex === undefined))) throw new Error("browser_command_invalid");
    if (["tab-list", "tab-current"].includes(command) && options.page !== undefined) throw new Error("browser_command_invalid");
    if (command === "tab-switch" && options.page === undefined && tabIndex === undefined && tabLabel === undefined) throw new Error("browser_page_required");
    if ((options.limit !== undefined && !["console", "errors", "network"].includes(command)) || (options.before !== undefined && !["console", "errors"].includes(command))) throw new Error("browser_command_invalid");
    const networkQuery = command === "network" && !networkHistory ? browserNetworkQuery(options) : undefined;
    if (command !== "cookie" && ["url", "domain", "path", "secure", "httpOnly", "sameSite", "expires", "cookieFile"].some((key) => options[key] !== undefined)) throw new Error("browser_command_invalid");
    if (!["viewport", "media", "geo", "offline", "headers", "permission", "set"].includes(command) && ["scale", "mobile", "colorScheme", "reducedMotion", "accuracy"].some((key) => options[key] !== undefined)) throw new Error("browser_command_invalid");
    const counts = { create: 0, list: 0, use: 1, show: 1, "tab-list": 1, "tab-current": 1, "tab-show": 1, network: 1, control: 1, snapshot: 1, screenshot: 1, "full-screenshot": 1, pdf: 1, artifact: 1, download: 2, goto: 2, pushstate: 2, "init-script": 3, back: 1, forward: 1, reload: 1, tap: 2, swipe: 2, click: 2, dblclick: 2, select: 3, check: 2, uncheck: 2, focus: 2, clear: 2, "select-all": 2, hover: 2, highlight: 2, scrollintoview: 2, scroll: 3, drag: 3, fill: 3, inserttext: 2, keyboard: 3, key: 2, keydown: 2, keyup: 2, eval: 2, "tab-new": 2, "tab-switch": 1, "tab-close": 1, close: 1, disconnect: 1, receipt: 1 };
    if (imageCapture) counts[command] += values.length;
    if (resourceSelection.all) counts[command] = 0;
    counts.vitals = values.length + 1;
    if (diff) counts.diff = 2;
    if (react) counts.react = values.length + 1;
    if (command === "vitals" && (values.length > 1 || values.length === 1 && (!values[0] || Buffer.byteLength(values[0]) > 8192 || !/^(https?:\/\/|about:blank$)/.test(values[0])))) throw new Error("browser_url_invalid");
    counts.frame = 2;
    counts["window-new"] = 1;
    const finding = command === "find" ? browserFind(values, options) : undefined;
    const data = ["cookie", "storage"].includes(command) ? browserData(command, values, options, cwd) : undefined;
    const clipboard = command === "clipboard" ? browserClipboard(values, options) : undefined;
    const mouse = command === "mouse" ? browserMouse(values) : undefined;
    let swipe;
    if (command === "swipe") {
      const [direction, distance = "300"] = values;
      const limit = direction === "right" ? 999_800 : direction === "down" ? 999_600 : 1_000_000;
      if (values.length < 1 || values.length > 2 || !["up", "down", "left", "right"].includes(direction) || !/^(0|[1-9][0-9]{0,6})$/.test(distance) || Number(distance) > limit) throw new Error("browser_swipe_invalid");
      swipe = { kind: "swipe", direction, distance: Number(distance) };
      counts.swipe = values.length + 1;
    }
    let keyboard;
    if (command === "keyboard") {
      if (values.length !== 2 || !["type", "inserttext", "insertText"].includes(values[0]) || !values[1]) throw new Error("browser_command_invalid");
      keyboard = { kind: values[0] === "type" ? "type_text" : "insert_text", text: values[1] };
    }
    let initScript;
    if (command === "init-script") {
      if (values.length !== 2 || !["add", "remove"].includes(values[0])) throw new Error("browser_command_invalid");
      if (values[0] === "add" && Buffer.byteLength(values[1]) > 64 * 1024) throw new Error("browser_script_too_large");
      if (values[0] === "remove" && (values[1].length > 4096 || !/^init:v1:[A-Za-z0-9_-]+$/.test(values[1]))) throw new Error("browser_init_script_identifier_invalid");
      initScript = { kind: "init_script", action: { kind: values[0], [values[0] === "add" ? "script" : "identifier"]: values[1] } };
    }
    const frameAction = command === "frame" && values.length === 1
      ? values[0] === "main" ? { kind: "main_frame" } : { kind: "frame", target: elementTarget(values[0]) } : undefined;
    const dialog = command === "dialog" ? browserDialog(values, options) : undefined;
    const console = ["console", "errors"].includes(command) ? browserConsole(values, options, implicitController, command === "errors" ? "exception" : undefined) : undefined;
    const environment = ["viewport", "device", "media", "geo", "offline", "headers", "permission", "set"].includes(command) ? browserEnvironment(command, values, options) : undefined;
    const query = data?.query ?? finding?.query ?? (["get", "is"].includes(command) ? browserQuery(command, values, elementTarget) : undefined);
    const waiting = command === "wait" ? browserWait(values, options) : undefined;
    if (!profiles && ((query || waiting || finding || uploading || stateLoading || stateSaving || data || clipboard || environment || mouse || dialog || console || networkHistory || networkCapture || recording || tracing || interception) ? !resourceId : (!Object.hasOwn(counts, command) || options.positional.length !== counts[command] + 1))) throw new Error("browser_command_invalid");
    if (command === "pushstate" && Buffer.byteLength(values[0]) > 8192) throw new Error("browser_history_url_too_large");
    const launchScripts = await browserLaunchScripts(command, options.initScriptFiles, { cwd, environment: sourceEnvironment });
    const inputAction = () => {
      let action = react ?? initScript ?? frameAction ?? swipe ?? mouse ?? keyboard ?? environment ?? data?.action ?? clipboard ?? finding?.action;
      if (command === "vitals") action = { kind: "vitals", ...(values.length ? { url: values[0] } : {}) };
      if (command === "window-new") action = { kind: "new_window" };
      if (downloading) action = { kind: "download", target: elementTarget(values[0]), timeout_ms: downloadTimeout };
      if (uploading) action = { kind: "upload", target: elementTarget(values[0]), files: [] };
      if (stateLoading) action = { kind: "state_load" };
      if (stateSaving) action = { kind: "state_save", ...(stateEncryption === undefined ? {} : { encryption_key: stateEncryption }) };
      if (command === "pdf") action = { kind: "print_pdf" };
      if (command === "goto" || command === "tab-new") action = { kind: command === "goto" ? "navigate" : "new_page", url: values[0], ...(tabLabel === undefined ? {} : { label: tabLabel }) };
      else if (command === "pushstate") action = { kind: "push_state", url: values[0] };
      else if (command === "tab-close") action = { kind: "close_page" };
      else if (command === "disconnect") action = { kind: "disconnect" };
      else if (command === "tab-switch") action = { kind: "select_page" };
      else if (["back", "forward", "reload"].includes(command)) action = { kind: command };
      else if (ELEMENT_COMMANDS.includes(command)) {
        const kind = ({ dblclick: "double_click", "select-all": "select_all", scrollintoview: "scroll_into_view", clear: "fill" })[command] ?? command;
        action = { kind, target: elementTarget(values[0]), ...(kind === "fill" ? { text: command === "clear" ? "" : values[1] } : {}), ...(kind === "select" ? { values: [values[1]] } : {}) };
      } else if (command === "drag") action = { kind: "drag", source: elementTarget(values[0]), target: elementTarget(values[1]) };
      else if (command === "scroll") {
        if (!/^(0|[1-9][0-9]{0,6})$/.test(values[1])) throw new Error("browser_scroll_invalid");
        action = { kind: "scroll", direction: values[0], amount: Number(values[1]) };
      }
      else if (command === "inserttext") action = { kind: "insert_text", text: values[0] };
      else if (command === "key") action = { kind: "press", key: values[0] };
      else if (command === "keydown" || command === "keyup") action = { kind: command === "keydown" ? "key_down" : "key_up", key: values[0] };
      else if (command === "eval") action = { kind: "evaluate", script: values[0] };
      else if (waiting?.function) action = { kind: "wait_function", wait: waiting.function };
      return action;
    };
    let action = implicitController ? inputAction() : undefined;
    const deadlineMs = waiting?.deadlineMs ?? 45_000;
    backend = await resolveBackend({ backend: options.backend, backendSpecified: options.backend !== undefined });
    if (!backend?.profile || backend.error) return { ok: false, operation_id: operationId, error: backendRequestFailure(backend?.error, backend?.profile) };
    const aggregateDeadline = resourceSelection.all ? Date.now() + deadlineMs : undefined;
    let selectedResource;
    const request = async (body) => {
      const remainingMs = aggregateDeadline === undefined ? deadlineMs : aggregateDeadline - Date.now();
      if (remainingMs <= 0) throw new Error("browser_tab_list_timeout");
      const response = await requestBackend(
        { ...backend.profile, deadlineMs: remainingMs },
        { requestId: randomUUID(), operation: "browser.resource", requiredCapabilities: ["browser.resource.v1", ...(uploading || downloading || stateLoading || diff ? ["browser.files.v1"] : []), ...(exportsFile ? ["browser.capture.v1"] : []), ...(tracing ? ["browser.tracing.v1"] : []), ...(query || console ? ["browser.query.v1"] : []), ...(finding ? ["browser.find.v1"] : []), ...(waiting ? ["browser.wait.v1"] : []), ...(command === "network" || networkCapture || interception ? ["browser.network.v1"] : [])], body },
        { ...backend.transportOptions, deadlineMs: remainingMs, maxResponseBytes: 2 * 1024 * 1024 },
      );
      assertBrowserResource(selectedResource, body.kind, response.result);
      return response.result;
    };
    if (resourceSelection.scoped) {
      const catalog = await request({ kind: "list" });
      selectedResource = browserCatalogResource(catalog?.result);
      resourceId = selectedResource.resource_id;
    }
    const needsController = !!(action || profileChange || dialog?.response || console?.clear || networkHistory?.clear
      || (interception && interception.command !== "list") || (networkCapture && networkCapture.action !== "status") || (recording && recording.action !== "status") || (tracing && tracing.action !== "status"));
    if (implicitController && (needsController || command === "control" || command === "snapshot")) {
      sessionController = await resolveBrowserSessionController(sourceEnvironment, backend, requestBackend);
      if (command === "control") options.controller = sessionController.controller_id;
      else {
        const prepared = await prepareBrowserSessionControl(request, resourceId, sessionController, operationId, { snapshot: command === "snapshot" });
        selectedResource ??= prepared.resource;
        if (prepared.lease) {
          options.controller = sessionController.controller_id;
          options.epoch = prepared.lease.epoch;
        }
      }
    }
    let result;
    if (resourceSelection.all) {
      const tabs = await allBrowserTabs(request);
      if (command === "tab-current") {
        const tab = tabs.find((row) => row.active);
        if (!tab) throw new Error("browser_page_required");
        result = { result: { tab } };
      } else result = { result: { tabs: options.showProfile ? await browserTabsWithProfiles(request, tabs) : tabs } };
    } else if (profiles && !profileChange && !profileShow) {
      result = await request(profiles);
    } else if (command === "create" || command === "list") {
      result = await request({ kind: command, ...(command === "create" ? { operation_id: operationId, ...(options.profileId !== undefined ? { profile_id: options.profileId } : {}), ...(launchScripts !== undefined ? { init_scripts: launchScripts } : {}), ...(launchFeatures !== undefined ? { features: launchFeatures } : {}) } : {}) });
    } else if (command === "use") {
      result = await selectBrowserResource(request, resourceId, operationId);
    } else if (command === "receipt") {
      result = await request({ kind: "receipt", operation_id: resourceId });
    } else if (command === "artifact") {
      operationId = resourceId;
      result = { operation_id: operationId, result: await downloadBrowserArtifact(request, operationId, options.output) };
    } else if (interception) {
      result = await performBrowserInterception(request, resourceId, interception, options, operationId);
    } else if (tracing) {
      result = await performBrowserTracing(request, resourceId, tracing, options, operationId, { profile: backend.profile, environment: sourceEnvironment, cwd });
    } else if (recording) {
      result = await performBrowserRecording(request, resourceId, recording, options, operationId, { profile: backend.profile, environment: sourceEnvironment, cwd });
    } else if (networkCapture) {
      result = await performBrowserNetworkCapture(request, resourceId, networkCapture, options, operationId);
      if (networkCapture.action === "stop" && result?.result && result.result.response?.success !== false) {
        Object.assign(result.result, await downloadBrowserArtifact(request, operationId, options.output));
      }
    } else if (dialog) {
      result = await performBrowserDialog(request, resourceId, dialog, options, operationId);
    } else if (console) {
      result = await performBrowserConsole(request, resourceId, console, options, operationId);
    } else if (networkHistory) {
      result = await performBrowserNetworkHistory(request, resourceId, networkHistory, options, operationId);
      if (networkHistory.sequence && result?.result?.artifact && !result?.error) {
        Object.assign(result.result, await downloadBrowserArtifact(request, operationId, options.output));
      }
    } else if (command === "control" || command === "close") {
      const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
      const resource = control?.resource;
      if (resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
      if (command === "control") {
        if (!options.controller) throw new Error("browser_controller_required");
        result = await request({ kind: "control", resource, controller_id: options.controller, expected: control.controller, operation_id: operationId });
      } else result = await request({ kind: "close", resource, operation_id: operationId });
    } else {
      const inspected = await request({ kind: "observe", resource_id: resourceId });
      const view = inspected.result;
      if (!view?.control?.resource || !Array.isArray(view.pages)) throw new Error("browser_response_invalid");
      const resource = view.control.resource;
      if (resource.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
      const namedPage = tabLabel === undefined || command === "tab-new" ? undefined : browserTabWithLabel(view, tabLabel).page;
      if (namedPage && options.page !== undefined && namedPage.page_id !== options.page) throw new Error("browser_tab_target_mismatch");
      if (command === "show") result = inspected;
      else if (["tab-list", "tab-current", "tab-show"].includes(command)) {
        const tabs = browserTabRows(view);
        if (command === "tab-list") result = { result: { tabs: options.showProfile ? await browserTabsWithProfiles(request, tabs) : tabs } };
        else {
          const tab = command === "tab-current" ? tabs.find((row) => row.active) : tabs.find((row) => row.page.page_id === (namedPage?.page_id ?? options.page));
          if (!tab) throw new Error("browser_page_required");
          result = { result: { tab } };
        }
      }
      else {
        if (!implicitController) action = inputAction();
        const referenced = captureTarget?.reference?.snapshot.page ?? query?.target?.reference?.snapshot.page ?? action?.source?.reference?.snapshot.page ?? action?.target?.reference?.snapshot.page;
        if (referenced && (referenced.resource.resource_id !== resourceId || (options.page !== undefined && referenced.page_id !== options.page))) throw new Error("browser_reference_page_mismatch");
        const indexed = tabIndex === undefined ? undefined : view.pages[tabIndex]?.page;
        if (tabIndex !== undefined && !indexed) throw new Error("browser_tab_index_invalid");
        if (indexed && options.page !== undefined && indexed.page_id !== options.page) throw new Error("browser_tab_target_mismatch");
        const page = referenced ?? namedPage ?? indexed ?? (options.page !== undefined ? view.pages.find((row) => row.page.page_id === options.page)?.page : browserCurrentPage(view.control));
        if (page && !referenced && !view.pages.some((row) => sameBrowserPage(row.page, page))) throw new Error("browser_response_invalid");
        if (!page) throw new Error("browser_page_required");
        if (profileShow) {
          result = { result: view.pages.find((entry) => entry.page.page_id === page.page_id) };
        } else if (waiting?.wait) {
          result = await request({ kind: "wait", page, wait: waiting.wait });
        } else if (command === "network") {
          result = projectBrowserNetwork(await request({ kind: "network", page }), page, networkQuery);
        } else if (query) {
          result = await request({ kind: "query", page, query });
        } else if (command === "snapshot" || diffSnapshot) {
          const observedOptions = diffSnapshot ? { ...diffSnapshot, diff_baseline: await stageBrowserUploadBytes(request, resource, "snapshot-baseline.txt", Buffer.from(diffSnapshot.diff_baseline, "utf8")) } : snapshotOptions;
          result = await request({ kind: "snapshot", page, ...(observedOptions ? { options: observedOptions } : {}) });
          const observed = result.result;
          if (observed?.data?.refs && observed.snapshot) {
            result.references = Object.fromEntries(Object.entries(observed.data.refs).map(([element, description]) => [encodeRef(observed.snapshot, element), description]));
          }
        } else if (diffScreenshot) {
          const [baseline] = await stageBrowserUploads(request, resource, [diffScreenshot.baseline]);
          result = await request({ kind: "capture_diff", page, baseline, threshold: diffScreenshot.threshold, options: { full_page: diffScreenshot.full_page, ...(captureTarget ? { target: captureTarget } : {}) }, operation_id: operationId });
          if (diffScreenshot.output !== undefined && result?.result?.artifact) Object.assign(result.result, await downloadBrowserArtifact(request, operationId, diffScreenshot.output));
        } else if (imageCapture) {
          result = await request({ kind: "capture", page, options: { full_page: command === "full-screenshot", format: options.format ?? "png", ...(captureTarget ? { target: captureTarget } : {}), ...(quality === undefined ? {} : { quality }), ...(options.annotate ? { annotate: true } : {}) }, operation_id: operationId });
        } else {
          const authority = browserActionAuthority(view.control, page, options, operationId);
          if (stateSaving && options.output === undefined) options.output = await defaultBrowserStateOutput(sourceEnvironment, resource.resource_id, stateEncryption !== undefined);
          if (uploading) action.files = await stageBrowserUploads(request, resource, values.slice(1));
          if (stateLoading) {
            const input = await browserStateInput(resolve(cwd ?? process.cwd(), values[1]), stateEncryption);
            [action.file] = await stageBrowserUploads(request, resource, [input.path]);
            if (input.encryption_key !== undefined) action.encryption_key = input.encryption_key;
          }
          result = await request({ kind: profileChange?.kind ?? "action", caller: options.controller, authority, ...(profileChange ? { profile_id: profileChange.profile_id, ...(profileNewPage ? { url: profileNewPage.url, ...(tabLabel === undefined ? {} : { label: tabLabel }) } : {}) } : { action }) });
        }
        if (imageCapture && result?.result?.snapshot) {
          if (!sameBrowserPage(result.result.snapshot.page, page) || !Array.isArray(result.result.annotations)) throw new Error("browser_response_invalid");
          result.result.annotations = result.result.annotations.map(({ element, ...annotation }) => ({ ...annotation, ref: encodeRef(result.result.snapshot, element) }));
          result.references = Object.fromEntries(result.result.annotations.map(({ ref, role, name }) => [ref, { role, name }]));
        }
        if ((imageCapture || command === "pdf" || downloading || stateSaving) && result?.result && result.result.response?.success !== false) {
          if (stateSaving && stateEncryption !== undefined && result.result.response?.data?.encrypted !== true) throw new Error("browser_state_encryption_unconfirmed");
          Object.assign(result.result, await downloadBrowserArtifact(request, operationId, options.output));
        }
      }
    }
    return { ok: !result?.error && result?.result?.response?.success !== false && (!result?.replayed || result.receipt?.state === "succeeded"), operation_id: operationId, ...result, ...(sessionController ? { session_controller: sessionController } : {}) };
  } catch (error) {
    return {
      ok: false, operation_id: operationId,
      ...(sessionController ? { session_controller: sessionController } : {}),
      error: error instanceof BrowserCommandError ? error.diagnostic
        : error?.name === "Error" && error.message.startsWith("browser_")
        ? { code: error.message }
        : backendRequestFailure(error, backend?.profile),
    };
  }
}
