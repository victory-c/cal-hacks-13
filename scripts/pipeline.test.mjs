import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeJudge } from '@canon/shared';
import { startServer } from '../server/src/app.ts';
import { KeywordRetriever } from '../server/src/retrieval/keyword.ts';
import { simulatedScopeAnswers } from '../server/src/scope-judge.ts';
import { createClient } from '../distiller/src/client.ts';
import { createHandler } from '../distiller/src/worker.ts';

test('HTTP capture → writer → triage → living scope → MCP; durable catch-up is idempotent', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bullwark-loop-'));
  const grants=[{client:'ben',principal:'ben',read:[],write:[]},{client:'wags',principal:'wags',read:[],write:[]},{client:'distiller',read:[],write:['research','inbox']}];
  const tokens=new Map(grants.map(g=>['test-'+g.client,g.client]));
  const world={groups:[{id:'research/asset-managers',description:'Public research',aliases:[]}],principals:[{id:'ben',kind:'person',name:'Ben Kim',tier:'member'},{id:'wags',kind:'person',name:'Wags',tier:'moderator'}],rules:[{principal:'ben',task:'Public research holdings',exclude:{groups:['deal'],labels:[]},set_by:'wags',updated_at:new Date().toISOString()}],initial_scopes:['ben'],scopes:[],audit:[],quarantine:[]};
  const judge=new FakeJudge({override:simulatedScopeAnswers});
  const start=()=>startServer({dataDir:dir,world,grants,tokens,judge,retriever:new KeywordRetriever(),log:()=>{}});
  let server=await start();
  const call=async(path,body,client='ben')=>{
    const r=await fetch(server.url+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer test-'+client,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;
  };
  let writes=0;
  const distiller={name:'heuristic',async distill(session){writes++;return {simulated:true,drafts:[{statement:'Public research holdings are 210000 shares',folder:'research/asset-managers',source:{client:session.client,session:session.id}}]};}};
  const worker=()=>createHandler({client:createClient({baseUrl:server.url,token:'test-distiller'}),distiller,judge:new FakeJudge({override:q=>q.type==='noul'?{id:q.id,type:q.type,p:q.id.startsWith('keep:')?0.95:0.01}:q.type==='choice'?{id:q.id,type:q.type,choice:q.id.startsWith('group:')?'research/asset-managers':q.id.startsWith('rel:')?'unrelated':'none',p:0.95}:undefined}),live:false});
  try {
    const captured=await call('/api/sessions',{id:'ses_aa1122',client:'claude-code',external:false,started_at:'2026-10-24T10:00:00Z',ended_at:'2026-10-24T10:01:00Z',messages:[{role:'user',content:'Public research holdings are 210000 shares'}]});
    assert.ok(captured);
    // No worker existed when the capture arrived: recovery must read the cold archive over HTTP.
    const first=worker();await first.recover();await first.settle();
    let memory;
    for(let i=0;i<100;i++){memory=await call('/api/facts');if(memory.facts.length)break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(memory.facts.length,1);assert.equal(memory.facts[0].author,'ben');assert.equal(memory.facts[0].group,'research/asset-managers');
    const mcp=async()=>{
      const r=await fetch(server.url+'/mcp',{method:'POST',headers:{authorization:'Bearer test-ben','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'canon_context',arguments:{task:'Public research holdings'}}})});
      assert.equal(r.status,200);const wire=await r.text();const payload=wire.includes('data:')?JSON.parse(wire.split('\n').find(x=>x.startsWith('data:')).slice(5)):JSON.parse(wire);return payload.result.structuredContent;
    };
    const context=await mcp();assert.equal(context.facts.length,1);assert.ok(context.profile);assert.equal('missing' in context,false);
    const id=memory.facts[0].id;
    await server.close();server=await start();
    const second=worker();await second.recover();await second.settle();
    assert.equal(writes,1,'a durable receipt prevents extraction after restart');
    assert.equal((await call('/api/facts')).facts[0].id,id);
    assert.equal((await mcp()).facts[0].id,id);
  } finally {await server.close();await rm(dir,{recursive:true,force:true});}
});
