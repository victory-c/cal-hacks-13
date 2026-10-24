import assert from "node:assert/strict";
import { test } from "node:test";
import type { Fact } from "@canon/shared";
import { MossRetriever } from "./moss.ts";

const fact=(id:string,folder:Fact['folder'],tier:Fact['tier']='hot'):Fact=>({id,folder,tier,statement:'Synthetic project fact',jev_keep:0.9,updated:'2026-10-24',source:{client:'claude-code',session:'ses_abcd'}});

test('Moss filters allowed nested folders BEFORE ranking and rechecks canonical IDs',async()=>{
  let requested: unknown;
  const removed:string[]=[];
  const stored:string[]=[];
  const retriever=new MossRetriever({client:{
    session:async()=>({
      addDocs:async docs=>{stored.push(...docs.map(doc=>doc.id));return {added:docs.length,updated:0};},
      deleteDocs:async ids=>{removed.push(...ids);return ids.length;},
      query:async(_query,opts)=>{requested=opts;return {docs:[{id:'fct_aaaa',score:0.8},{id:'fct_bbbb',score:0.99},{id:'fct_dead',score:1}]} as never;},
    }),close:async()=>{},
  }});
  await retriever.index([fact('fct_aaaa','projects/canon'),fact('fct_bbbb','private'),fact('fct_cccc','projects','cold')]);
  const hits=await retriever.search('project',{folders:['projects'],k:2});
  assert.deepEqual(requested,{topK:2,alpha:0.6,filter:{field:'folder',condition:{$in:['projects/canon']}}});
  assert.deepEqual(hits.map(hit=>hit.fact.id),['fct_aaaa']);
  assert.deepEqual(stored,['fct_aaaa','fct_bbbb']);
  await retriever.index([fact('fct_bbbb','private')]);
  assert.deepEqual(removed,['fct_aaaa']);
  assert.deepEqual(await retriever.search('project',{folders:['projects'],k:2}),[]);
});

test('failed indexing fails closed and a later complete replacement recovers',async()=>{
  let fail=true;
  const retriever=new MossRetriever({client:{session:async()=>({
    addDocs:async()=>{if(fail)throw new Error('embedding unavailable');return {added:1,updated:0};},
    deleteDocs:async()=>0,query:async()=>({docs:[]} as never),
  }),close:async()=>{}}});
  await assert.rejects(retriever.index([fact('fct_aaaa','projects')]),/embedding unavailable/);
  await assert.rejects(retriever.search('project',{folders:['projects'],k:1}),/not ready/);
  fail=false;
  await retriever.index([fact('fct_aaaa','projects')]);
  assert.deepEqual(await retriever.search('project',{folders:['projects'],k:1}),[]);
});
