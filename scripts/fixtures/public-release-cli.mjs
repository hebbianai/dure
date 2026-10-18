import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";
import {
  RELEASE_CARGO_WORKSPACES,
  prepareReleaseCandidate,
  replaceReleaseCargoLock,
} from "../lib/release-candidate.mjs";

// Jobs of a full public-repository.yml run. The frontend and script suites
// run as matrix jobs whose names carry a shard or test-file suffix.
export const PUBLIC_CI_JOB_NAMES = Object.freeze([
  "Select public checks",
  "Documentation checks",
  "Frontend checks (shard 1)",
  "Frontend checks (shard 2)",
  "Frontend checks (shard 3)",
  "Script checks (vitest)",
  "Script checks (node cli/lib/provider-launch-selection.test.mjs)",
  "Script checks (deadline scripts/dure-cli-wait.test.mjs)",
  "Script checks (process scripts/run-dev-app.test.mjs)",
  "Mobile web checks",
  "Shared protocol (ubuntu-24.04)",
  "Hmux checks",
  "App core checks",
  "Public repository checks",
]);

const fakeGh = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const argv=process.argv.slice(2), stateFile=process.env.RELEASE_TEST_STATE;
let state=JSON.parse(fs.readFileSync(stateFile));
const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state));
const answer=value=>{save();console.log(JSON.stringify(value));};
const fail=(status,message='fixture API refusal')=>{save();console.log(JSON.stringify({status:String(status),message}));console.error('HTTP '+status);process.exit(1);};
fs.appendFileSync(process.env.RELEASE_TEST_CALLS,JSON.stringify(argv)+'\n');
const arg=name=>argv[argv.indexOf(name)+1];
const timeout=key=>{if(!(state.flakyDownloads?.[key]>0))return;state.flakyDownloads[key]--;fs.writeFileSync(path.join(arg('--dir'),'partial-download'),'');save();console.error('read tcp 10.0.0.2:50000->140.82.112.6:443: read: operation timed out');process.exit(1);};
const sha=bytes=>crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const previous=bytes=>({type:'file',path:'beta/latest.json',encoding:'base64',sha:sha(bytes),content:bytes.toString('base64')});
// Public CI: one completed run per commit unless state.ciRuns lists several.
// Run ids are registered on listing and stay clear of the release run id.
const ciJobNames=${JSON.stringify(PUBLIC_CI_JOB_NAMES)};
const ciRuns=commit=>(state.ciRuns?.[commit]??[{}]).map((run,index)=>{
  const key=commit+'/'+index;
  state.ciRunIds??={};
  state.ciRunIds[key]??=1000+Object.keys(state.ciRunIds).length;
  return {id:state.ciRunIds[key],conclusion:run.conclusion??state.ciConclusions?.[commit]??state.ciConclusion??'success',jobs:{...state.ciJobs,...run.jobs}};
});
if(argv[0]==='api'){
  const route=argv[1];
  if(route==='user'){
    answer({login:state.operator??'release-admin'});
  }else if(route.includes('/compare/')){
    answer({base_commit:{sha:route.split('/compare/')[1].split('...')[0]},status:state.toolingComparison??'identical'});
  }else if(route.includes('/collaborators/')){
    answer({permission:state.permissions?.[route.split('/').at(-2)]??'admin'});
  }else if(route.includes('/commits/')){
    const ref=decodeURIComponent(route.split('/commits/')[1]);
    const sha=state.refs?.[ref];
    if(!sha)fail(404);else answer({sha});
  }else if(route.includes('/contents/beta/latest.json')){
    if(argv.includes('--method')){
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      if(state.metadataConflict){state.previous=previous(Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(state.previous.content,'base64')),version:'0.2.30',platforms:{'darwin-aarch64':{signature:'other',url:'https://github.com/hebbianai/dure/releases/download/v0.2.30/Dure.app.tar.gz'}}})));fail(409);}
      if(input.sha!==state.previous?.sha)fail(409);
      state.previous=previous(Buffer.from(input.content,'base64'));
      if(state.lostMetadataResponse)fail(500,'response lost after commit');
      answer({content:{sha:state.previous.sha}});
    }else if(state.previous)answer(state.previous);else fail(404);
  }else if(route.includes('/releases/tags/')){
    if(state.releaseReadError)fail(state.releaseReadError);
    if(state.draftByTagMissing&&state.release?.draft)fail(404);
    if(route.startsWith('repos/hebbianai/dure/')&&state.release)answer(state.release);else fail(404);
  }else if(route.startsWith('repos/hebbianai/dure/releases?')){
    if(state.releaseListError)fail(state.releaseListError);
    const page=Number(new URL('https://fixture/'+route).searchParams.get('page'));
    if(state.release&&state.hiddenListings>0){state.hiddenListings--;answer([]);}
    else answer(state.releasePages?.[page-1]??[...(state.release?[state.release]:[]),...(state.extraReleases??[])]);
  }else if(/^repos\/hebbianai\/dure\/releases\/\d+$/.test(route)){
    if(state.releaseDetailError)fail(state.releaseDetailError);
    if(Number(route.split('/').at(-1))!==state.release?.id)fail(404);
    answer(state.releaseDetail??state.release);
  }else if(route.includes('/git/ref/')){
    if(route.startsWith('repos/hebbianai/dure/')&&state.hasRemoteTag)answer({object:{type:'commit',sha:state.tagSha}});else fail(404);
  }else if(route.includes('/actions/runs/')&&route.includes('/jobs?')){
    const runId=Number(route.split('/actions/runs/')[1].split('/')[0]);
    const ciKey=Object.keys(state.ciRunIds??{}).find(key=>state.ciRunIds[key]===runId);
    if(ciKey){
      const [commit,index]=ciKey.split('/'),run=ciRuns(commit)[Number(index)];
      answer({total_count:ciJobNames.length,jobs:ciJobNames.map(name=>({name,status:'completed',conclusion:run.jobs[name]??'success'}))});
    }else{
      const verification=state.actualVerification??'success',preflight=verification==='success'?'skipped':'success';
      answer({total_count:7,jobs:['source','candidate','verification','host-preflight','version','build','draft'].map(name=>({name,conclusion:state.jobConclusions?.[name]??(name==='verification'?verification:name==='host-preflight'?preflight:'success')}))});
    }
  }else if(route.includes('/actions/runs/')){
    answer({repository:{full_name:'hebbianai/dure'},path:'.github/workflows/release.yml',event:'workflow_dispatch',head_branch:state.headBranch??'main',head_sha:state.workflowSha??state.sourceSha,status:'completed',conclusion:state.runConclusion??'success'});
  }else fail(400,'unmodeled API '+route);
}else if(argv[0]==='run'&&argv[1]==='list'){
  if(arg('--workflow')!=='public-repository.yml')fail(404,'wrong workflow');
  const commit=arg('--commit');
  answer(ciRuns(commit).map(run=>({databaseId:run.id,headSha:commit,status:'completed',conclusion:run.conclusion})));
}else if(argv[0]==='run'&&argv[1]==='download'){
  timeout(arg('--name'));
  if(state.expiredArtifacts){save();console.error('no valid artifacts found to download');process.exit(1);}
  if(arg('--name')==='release-selection'){
    fs.writeFileSync(path.join(arg('--dir'),'selection.json'),JSON.stringify(state.selection??{schemaVersion:1,runId:'239',sourceRef:'main',workflowSha:state.workflowSha??state.sourceSha,sourceSha:state.sourceSha,tag:'v0.2.29',verification:'full'}));
  }else for(const name of fs.readdirSync(state.original))fs.copyFileSync(path.join(state.original,name),path.join(arg('--dir'),name));
}else if(argv[0]==='release'&&argv[1]==='create'){
  if(state.release)fail(422);
  state.release={id:91,tag_name:argv[2],body:arg('--notes'),draft:true,prerelease:true,assets:[]};
  if(state.lostCreateResponse)fail(500,'response lost after creation');
  answer(state.release);
}else if(argv[0]==='release'&&argv[1]==='upload'){
  const file=argv.at(-1),name=path.basename(file),bytes=fs.readFileSync(file);
  if(argv.includes('--clobber'))fail(400,'clobber forbidden');
  if(state.release.assets.some(asset=>asset.name===name))fail(422);
  if(state.failedUpload===name)fail(500,'upload not accepted');
  const asset={id:state.nextAssetId++,name,size:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex'),state:'uploaded'};
  state.release.assets.push(asset);
  if(state.lostUpload===name)fail(500,'response lost after upload');
  answer(asset);
}else if(argv[0]==='release'&&argv[1]==='download'){
  timeout('release-download');
  for(const asset of state.release.assets){
    const dest=path.join(arg('--dir'),asset.name);
    fs.copyFileSync(path.join(state.original,asset.name),dest);
    if(state.tamperDownload&&asset.name==='Dure.app.tar.gz')fs.appendFileSync(dest,'changed');
  }
}else if(argv[0]==='release'&&argv[1]==='edit'){
  if(argv.includes('--notes-file')){
    state.release.body=fs.readFileSync(arg('--notes-file'),'utf8');
    if(state.lostNotesResponse)fail(500,'response lost after notes update');
  }else{
    if(!argv.includes('--draft=false')||!argv.includes('--latest=false')||!argv.includes('--prerelease'))fail(400);
    if(!state.publishStillDraft)state.release.draft=false;
    if(state.lostPublishResponse)fail(500,'response lost after publish');
  }
  answer(state.release);
}else fail(400,'unmodeled gh '+argv.join(' '));
`;

const fakeCurl = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const argv=process.argv.slice(2),state=JSON.parse(fs.readFileSync(process.env.RELEASE_TEST_STATE));
fs.appendFileSync(process.env.RELEASE_TEST_CURL,JSON.stringify(argv)+'\n');
if(argv[0]!=='--disable'||argv.some(arg=>/authorization/i.test(arg)))process.exit(2);
const output=argv.includes('--output')?argv[argv.indexOf('--output')+1]:null,key=output?path.basename(argv.at(-1)):'feed';
if(state.flakyDownloads?.[key]>0){
  state.flakyDownloads[key]--;fs.writeFileSync(process.env.RELEASE_TEST_STATE,JSON.stringify(state));
  if(output)fs.writeFileSync(output,'partial');
  console.error('curl: (28) Operation timed out after 30000 milliseconds with 0 bytes received');process.exit(28);
}
if(output)fs.copyFileSync(path.join(state.original,key),output);
else{
  // true keeps the raw cache stale; a number goes stale for that many reads.
  const stale=state.staleReadback===true||state.staleReadback>0;
  if(typeof state.staleReadback==='number'&&stale){state.staleReadback--;fs.writeFileSync(process.env.RELEASE_TEST_STATE,JSON.stringify(state));}
  process.stdout.write(Buffer.from((stale?state.originalPrevious:state.previous).content,'base64'));
}
`;

const fakeGit = `#!/usr/bin/env node
const cp=require('node:child_process');
const argv=process.argv.slice(2).map(arg=>arg==='https://github.com/hebbianai/dure.git'?process.env.RELEASE_TEST_BARE:arg);
const result=cp.spawnSync('/usr/bin/git',argv,{env:process.env,stdio:'inherit'});
process.exit(result.status??1);
`;

export function createPublicReleaseFixture({ remoteVersion = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-release-cli-"));
  const repo = path.join(root, "repo"),
    bin = path.join(root, "bin"),
    original = path.join(root, "original"),
    bare = path.join(root, "remote.git"),
    temporary = path.join(root, "temporary");
  for (const directory of [repo, bin, original, temporary])
    fs.mkdirSync(directory);
  const env = withoutLocalGitOverrides();
  const git = (...argv) =>
    execFileSync("/usr/bin/git", argv, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), body);
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = Buffer.from("1122334455667788", "hex");
  const key = Buffer.from(
    `untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]).toString("base64")}\n`,
  ).toString("base64");
  write("package.json", '{"version":"0.2.28"}\n');
  write("cli/package.json", '{"version":"0.2.28"}\n');
  write(
    "src-tauri/tauri.conf.json",
    JSON.stringify({
      version: "0.2.28",
      plugins: { updater: { pubkey: key } },
    }),
  );
  write(
    "src-tauri/Cargo.toml",
    '[package]\nname = "dure"\nversion = "0.2.28"\n',
  );
  write("hmux/Cargo.toml", '[workspace.package]\nversion = "0.2.28"\n');
  for (const workspace of RELEASE_CARGO_WORKSPACES)
    write(
      workspace.lockPath,
      workspace.versionedPackages
        .map((name) => `[[package]]\nname = "${name}"\nversion = "0.2.28"\n\n`)
        .join(""),
    );
  git("init", "--initial-branch=main");
  git("config", "core.hooksPath", "/dev/null");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "release@example.test");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "source");
  const sourceSha = git("rev-parse", "HEAD");
  git("clone", "--bare", repo, bare);
  git("remote", "add", "origin", bare);
  const candidate = path.join(root, "candidate");
  prepareReleaseCandidate({
    root: repo,
    baseSha: sourceSha,
    bumpKind: "patch",
    outputDirectory: candidate,
    updateLocks(directory, current, next) {
      for (const workspace of RELEASE_CARGO_WORKSPACES) {
        const file = path.join(directory, workspace.lockPath);
        fs.writeFileSync(
          file,
          replaceReleaseCargoLock(
            fs.readFileSync(file, "utf8"),
            workspace,
            current,
            next,
          ),
        );
      }
    },
  });
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "-m", "release: v0.2.29");
  const tagSha = git("rev-parse", "HEAD");
  if (remoteVersion) {
    git("tag", "v0.2.29");
    git(
      "push",
      "origin",
      "HEAD:refs/heads/release/v0.2.29",
      "refs/tags/v0.2.29",
    );
  } else git("switch", "--detach", sourceSha);
  const archive = Buffer.from(
    "signed test payload, not a real native application",
  );
  const signed = sign(
    null,
    createHash("blake2b512").update(archive).digest(),
    privateKey,
  );
  const comment = "timestamp:1\tfile:Dure.app.tar.gz";
  const signature = Buffer.from(
    `untrusted comment: fixture\n${Buffer.concat([Buffer.from("ED"), id, signed]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey).toString("base64")}\n`,
  ).toString("base64");
  const manifest = {
    channel: "beta",
    version: "0.2.29",
    pub_date: "2026-09-18T00:00:00Z",
    platforms: {
      "darwin-aarch64": {
        signature,
        url: "https://github.com/hebbianai/dure/releases/download/v0.2.29/Dure.app.tar.gz",
      },
    },
  };
  fs.writeFileSync(path.join(original, "Dure.app.tar.gz"), archive);
  fs.writeFileSync(path.join(original, "Dure.app.tar.gz.sig"), signature);
  fs.writeFileSync(
    path.join(original, "Dure_0.2.29_aarch64.dmg"),
    "image fixture",
  );
  fs.writeFileSync(
    path.join(original, "latest.json"),
    JSON.stringify(manifest),
  );
  const prior = Buffer.from(
    JSON.stringify(manifest)
      .replaceAll("0.2.29", "0.2.27")
      .replaceAll("/dure/", "/hebbian-releases/"),
  );
  const previous = {
    type: "file",
    path: "beta/latest.json",
    encoding: "base64",
    content: prior.toString("base64"),
    sha: createHash("sha1")
      .update(`blob ${prior.length}\0`)
      .update(prior)
      .digest("hex"),
  };
  const statePath = path.join(root, "state.json"),
    calls = path.join(root, "calls.jsonl");
  const initial = {
    sourceSha,
    tagSha,
    original,
    nextAssetId: 100,
    release: null,
    hasRemoteTag: remoteVersion,
    previous,
    originalPrevious: previous,
  };
  fs.writeFileSync(statePath, JSON.stringify(initial));
  fs.writeFileSync(calls, "");
  for (const [name, contents] of [
    ["gh", fakeGh],
    ["git", fakeGit],
    ["curl", fakeCurl],
  ])
    fs.writeFileSync(path.join(bin, name), contents, { mode: 0o700 });
  const childEnv = {
    ...env,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    PATH: `${bin}${path.delimiter}${env.PATH}`,
    RELEASE_TEST_STATE: statePath,
    RELEASE_TEST_CALLS: calls,
    RELEASE_TEST_CURL: path.join(root, "curl.jsonl"),
    RELEASE_TEST_BARE: bare,
    GITHUB_REPOSITORY: "hebbianai/dure",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: sourceSha,
    RELEASE_SOURCE_SHA: sourceSha,
    REQUESTED_SOURCE_REF: "main",
    GITHUB_ACTOR: "release-admin",
    GITHUB_TRIGGERING_ACTOR: "release-admin",
    GITHUB_RUN_ID: "239",
    GITHUB_RUN_ATTEMPT: "1",
    RELEASE_BUMP: "patch",
    RELEASE_VERIFICATION: "full",
    GH_TOKEN: "fixture-token",
    GITHUB_OUTPUT: path.join(root, "github-output"),
    DURE_RELEASE_DOWNLOAD_RETRY_MS: "1",
    DURE_RELEASE_FEED_POLL_MS: "1",
    DURE_RELEASE_FEED_WAIT_MS: "20",
  };
  const state = () => JSON.parse(fs.readFileSync(statePath));
  const change = (values) =>
    fs.writeFileSync(statePath, JSON.stringify({ ...state(), ...values }));
  return {
    root,
    repo,
    bare,
    original,
    candidate,
    sourceSha,
    tagSha,
    git,
    env: childEnv,
    state,
    change,
    calls: () =>
      fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    run(script, ...argv) {
      return spawnSync(process.execPath, [script, ...argv], {
        cwd: repo,
        env: childEnv,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
    },
  };
}
