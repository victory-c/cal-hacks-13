import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPreviewGateway } from './preview-gateway.mjs';

const listen = async server => { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); return `http://127.0.0.1:${server.address().port}`; };
test('visible sign-in, signed cookie, safe redirects, and scoped API authentication',async t=>{
  const upstream=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({url:req.url,authorization:req.headers.authorization??null,cookie:req.headers.cookie??null}));});
  const target=await listen(upstream);
  const password='preview-test-password-long-enough';
  const gateway=createPreviewGateway({password,publicUrl:'http://localhost:8080',apiUrl:target,webUrl:target,principalTokens:{wags:'person-wags',ben:'person-ben'}});
  const url=await listen(gateway);
  t.after(()=>{gateway.closeAllConnections();gateway.close();upstream.closeAllConnections();upstream.close();});
  const page=await fetch(url);
  assert.equal(page.status,200);assert.match(await page.text(),/Open dashboard/);
  assert.equal((await fetch(url+'/api/facts')).status,401);
  const login=async(data,origin)=>fetch(url+'/login',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded',...(origin?{origin}:{})},body:new URLSearchParams(data)});
  assert.equal((await login({username:'team',password:'wrong'})).status,401);
  assert.equal((await login({username:'team',password},'https://evil.example')).status,403);
  const signed=await login({username:'team',password,next:'//evil.example'});
  assert.equal(signed.status,303);assert.equal(signed.headers.get('location'),'/');
  const cookie=signed.headers.get('set-cookie').split(';')[0];
  assert.match(signed.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const dashboard=await fetch(url,{headers:{cookie},redirect:'manual'});
  assert.equal(dashboard.status,302);assert.equal(dashboard.headers.get('location'),'/moderator.html');
  assert.equal((await fetch(url+'/login',{headers:{cookie}})).status,200);
  const facts=await fetch(url+'/api/facts',{headers:{cookie}});
  assert.equal(facts.status,200);assert.deepEqual(await facts.json(),{url:'/api/facts',authorization:'Bearer person-wags',cookie:null});
  assert.equal((await fetch(url+'/api/facts',{headers:{cookie:cookie+'tampered'}})).status,401);
  const benLogin=await login({username:'team',password,principal:'ben'});
  const benCookie=benLogin.headers.get('set-cookie').split(';')[0];
  const member=await fetch(url,{headers:{cookie:benCookie},redirect:'manual'});
  assert.equal(member.headers.get('location'),'/member.html');
  for (const path of ['/moderator.html','/moderator.js','/moderator.js.map','/%6doderator.js','/x%2f..%2fmoderator.js','/bench/latest.json']) {
    assert.equal((await fetch(url+path,{headers:{cookie:benCookie}})).status,404);
  }
  assert.equal((await fetch(url+'/moderator.js',{headers:{cookie}})).status,200);
  const scoped=await fetch(url+'/api/me',{headers:{cookie:benCookie}});
  assert.equal((await scoped.json()).authorization,'Bearer person-ben');
  assert.equal((await login({username:'team',password,principal:'distiller'})).status,400);
  assert.equal((await fetch(url+'/api/items',{method:'POST',headers:{cookie:benCookie,origin:'https://evil.example'}})).status,403);
  const bearer=await fetch(url+'/api/facts',{headers:{authorization:'Bearer client-token'}});
  assert.equal((await bearer.json()).authorization,'Bearer client-token');
  const basic=await fetch(url+'/health',{headers:{authorization:'Basic '+Buffer.from('team:'+password).toString('base64')}});
  assert.equal(basic.status,200);assert.equal((await basic.json()).authorization,'Bearer person-wags');
});
