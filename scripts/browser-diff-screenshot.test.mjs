import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'vitest';
import {tmpdir} from 'node:os';
import {collectBrowserCommand} from '../cli/lib/browser-command.mjs';
import {encodeRef} from '../cli/lib/browser-reference.mjs';
const resource={resource_id:'browser:diff-capture',workspace_id:'workspace:diff-capture',generation:'generation:diff-capture'};
const page={resource,page_id:'page:diff-capture',document_revision:'3'};
const directory=tmpdir();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(run,{result='different',fault}={}) {
 const cwd=await fs.mkdtemp(path.join(directory,'dure-browser-diff-screenshot-fixture-'));
 const baseline=Buffer.alloc(180013,0x62),output=Buffer.alloc(200003,0x69);
 const artifact={page,mimeType:'image/png',size:output.length,sha256:digest(output)};
 const calls=[];let received=0;
 await fs.writeFile(path.join(cwd,'기준.jpg'),baseline);
 await fs.writeFile(path.join(cwd,'difference.png'),'existing output');
 const collect=args=>collectBrowserCommand({args,cwd,sourceEnvironment:{},
  resolveBackend:async()=>({profile:{id:'selected',transport:{kind:'ssh'}}}),
  requestBackend:async(_profile,envelope)=>{
   const body=envelope.body;calls.push(body);
   assert(Buffer.byteLength(JSON.stringify(body))<256*1024);
   if(body.kind==='observe')return {result:{result:{control:{resource,current_page:page},pages:[{page}]}}};
   assert(envelope.requiredCapabilities.includes('browser.files.v1'));
   assert(envelope.requiredCapabilities.includes('browser.capture.v1'));
   if(body.kind==='upload_chunk') {
    assert.deepEqual(body.resource,resource);
    const bytes=Buffer.from(body.chunk.base64,'base64');
    assert.equal(body.chunk.offset,received);assert.deepEqual(bytes,baseline.subarray(received,received+bytes.length));received+=bytes.length;
    assert.equal(body.chunk.file.name,'기준.jpg');assert.equal(body.chunk.file.sha256,digest(baseline));
    if(fault==='upload')throw new Error('browser_response_lost');
    return {result:{result:{id:'a'.repeat(64),file:body.chunk.file,received,complete:received===baseline.length}}};
   }
   if(body.kind==='capture_diff') {
    assert.deepEqual(body.page,page);assert.equal(body.baseline,'a'.repeat(64));assert.equal(received,baseline.length);
    assert.equal(body.operation_id,'diff-capture-operation');
    if(fault==='capture')throw new Error('browser_response_lost');
    return {result:{result:{match:result==='same',mismatchPercentage:result==='same'?0:100,totalPixels:4,differentPixels:result==='same'?0:4,dimensionMismatch:result==='dimensions'?{expected:{width:2,height:2},actual:{width:4,height:1}}:null,...(result==='different'?{artifact}:{})}}};
   }
   if(body.kind==='artifact') {
    assert.equal(body.operation_id,'diff-capture-operation');
    if(fault==='artifact-lost'&&body.offset>0)throw new Error('browser_response_lost');
    const bytes=Buffer.from(output.subarray(body.offset,body.offset+65536));
    if(fault==='artifact-corrupt'&&body.offset>0)bytes[0]^=1;
    return {result:{artifact,offset:body.offset,base64:bytes.toString('base64'),eof:body.offset+bytes.length===output.length}};
   }
   throw new Error('unexpected request '+body.kind);
  }
 });
 try {await run({cwd,calls,collect,baseline,output});}
 finally {await fs.rm(cwd,{recursive:true,force:true});}
}
const direct=(...args)=>['diff',resource.resource_id,'screenshot','--idempotency-key','diff-capture-operation',...args];
const native=(command,...args)=>['exec',resource.resource_id,'--command',command,'--idempotency-key','diff-capture-operation',...args];
test('direct screenshot comparison stages caller bytes and atomically writes the verified artifact',()=>fixture(async f=>{
 const r=await f.collect(direct('--baseline','기준.jpg','--output','difference.png','--threshold','0.2','--selector','#main','--full'));
 assert.equal(r.ok,true,JSON.stringify(r));
 const capture=f.calls.find(x=>x.kind==='capture_diff');
 assert.deepEqual(capture.options,{full_page:true,target:{kind:'css',selector:'#main'}});assert.equal(capture.threshold,0.2);
 assert.equal(f.calls.filter(x=>x.kind==='capture_diff').length,1);
 assert.deepEqual(await fs.readFile(path.join(f.cwd,'difference.png')),f.output);
 assert.equal(JSON.stringify(f.calls).includes(f.cwd),false);
 assert.deepEqual((await fs.readdir(f.cwd)).sort(),['difference.png','기준.jpg'].sort());
}));
test('native screenshot spelling retains zero threshold, selector and full capture',()=>fixture(async f=>{
 const r=await f.collect(native("diff screenshot -b '기준.jpg' -o difference.png -t 0 -s '#main' -f --json"));
 assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(f.calls.find(x=>x.kind==='capture_diff').threshold,0);
 assert.deepEqual(await fs.readFile(path.join(f.cwd,'difference.png')),f.output);
}));
test('missing output retains the comparison and artifact receipt without transferring image chunks',()=>fixture(async f=>{
 const r=await f.collect(native("diff screenshot --baseline '기준.jpg'"));assert.equal(r.ok,true,JSON.stringify(r));
 assert.equal(f.calls.find(x=>x.kind==='capture_diff').threshold,0.1);
 assert(!f.calls.some(x=>x.kind==='artifact'));assert.equal(await fs.readFile(path.join(f.cwd,'difference.png'),'utf8'),'existing output');
}));
for(const result of ['same','dimensions'])test(result+' results preserve an existing destination and request no artifact',()=>fixture(async f=>{
 const r=await f.collect(direct('--baseline','기준.jpg','--output','difference.png'));assert.equal(r.ok,true,JSON.stringify(r));
 assert(!f.calls.some(x=>x.kind==='artifact'));assert.equal(await fs.readFile(path.join(f.cwd,'difference.png'),'utf8'),'existing output');
 assert.equal(r.result.match,result==='same');
},{result}));
for(const fault of ['upload','capture','artifact-lost','artifact-corrupt'])test(fault+' retains the existing output and never reissues capture',()=>fixture(async f=>{
 const r=await f.collect(direct('--baseline','기준.jpg','--output','difference.png'));assert.equal(r.ok,false);
 assert.equal(f.calls.filter(x=>x.kind==='capture_diff').length,fault==='upload'?0:1);
 assert.equal(await fs.readFile(path.join(f.cwd,'difference.png'),'utf8'),'existing output');
 assert.deepEqual((await fs.readdir(f.cwd)).sort(),['difference.png','기준.jpg'].sort());
},{fault}));
for(const threshold of ['NaN','Infinity','-.1','1.1','0x1','','1e400','0.2x'])test('invalid threshold '+JSON.stringify(threshold)+' stops before observation',()=>fixture(async f=>{
 const r=await f.collect(direct('--baseline','기준.jpg','--threshold',threshold));assert.equal(r.ok,false);assert.deepEqual(f.calls,[]);
}));
for(const threshold of ['0','1','.1','1e-1','+0.5','-0'])test('valid threshold '+threshold+' reaches the typed capture request',()=>fixture(async f=>{
 const r=await f.collect(direct('--baseline','기준.jpg','--threshold',threshold));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(f.calls.find(x=>x.kind==='capture_diff').threshold,Number(threshold));
}));
test('a Dure reference remains bound to its exact page and snapshot',()=>fixture(async f=>{
 const snapshot={page,revision:'7'};const ref=encodeRef(snapshot,'element:button');
 const r=await f.collect(direct('--baseline','기준.jpg','--selector',ref));assert.equal(r.ok,true,JSON.stringify(r));
 assert.deepEqual(f.calls.find(x=>x.kind==='capture_diff').options.target,{kind:'reference',reference:{snapshot,element:'element:button'}});
}));
test('a foreign reference is refused before upload or capture',()=>fixture(async f=>{
 const ref=encodeRef({page:{...page,resource:{...resource,resource_id:'browser:foreign'}},revision:'7'},'element:button');
 const r=await f.collect(direct('--baseline','기준.jpg','--selector',ref));assert.equal(r.ok,false);assert(!f.calls.some(x=>x.kind==='upload_chunk'||x.kind==='capture_diff'));
}));
test('missing baseline option fails before observation',()=>fixture(async f=>{assert.equal((await f.collect(direct())).ok,false);assert.deepEqual(f.calls,[]);}));
test('missing baseline file never captures',()=>fixture(async f=>{assert.equal((await f.collect(direct('--baseline','missing.png'))).ok,false);assert(!f.calls.some(x=>x.kind==='capture_diff'));}));
for(const option of ['--compact','--depth','--interactive','--format','--quality'])test('irrelevant option '+option+' is refused before observation',()=>fixture(async f=>{
 const value={'--depth':'2','--format':'png','--quality':'90'}[option];
 const r=await f.collect(direct('--baseline','기준.jpg',option,...(value?[value]:[])));assert.equal(r.ok,false);assert.deepEqual(f.calls,[]);
}));
