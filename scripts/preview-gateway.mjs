import { createServer, request } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { posix } from "node:path";

const COOKIE = "canon_preview";
const MAX_AGE = 86400;
const equal = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(),createHash("sha256").update(b).digest());
const safeNext = (value) => value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/";

export function createPreviewGateway({password, publicUrl, apiUrl="http://127.0.0.1:4100", webUrl="http://127.0.0.1:4200", principalTokens={}}) {
  if (!password || password.length < 24) throw new Error("PREVIEW_PASSWORD must be a generated preview password.");
  const origin = new URL(publicUrl).origin;
  const secure = origin.startsWith("https:") ? "; Secure" : "";
  const sign = (value) => createHmac("sha256", password).update(value).digest("base64url");
  const roles = { wags: "Wags · moderator", axe: "Axe · deal lead", ben: "Ben Kim · research", "dollar-bill": "Dollar Bill · portfolio manager" };
  const session = (principal) => {
    const payload = Buffer.from(JSON.stringify({principal,expires:Date.now()+MAX_AGE*1000})).toString("base64url");
    return `${payload}.${sign(payload)}`;
  };
  function authenticated(req) {
    const cookie = (req.headers.cookie ?? "").split(";").map(s=>s.trim()).find(s=>s.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);
    if (cookie) {
      const [payload, signature, extra] = cookie.split(".");
      try {
        if (!extra && payload && signature && equal(signature,sign(payload))) {
          const parsed=JSON.parse(Buffer.from(payload,"base64url").toString());
          if (parsed.expires>Date.now() && Object.hasOwn(roles,parsed.principal) && principalTokens[parsed.principal]) return parsed.principal;
        }
      } catch { /* Invalid cookies are unauthenticated. */ }
    }
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    return basic && equal(Buffer.from(basic[1],"base64").toString(),`team:${password}`) && principalTokens.wags ? "wags" : null;
  }
  function login(res, next, error=false) {
    const destination = safeNext(next).replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");
    res.writeHead(error?401:200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-frame-options":"DENY","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Bullwark</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101414;color:#eef2ee;font:16px system-ui}main{width:min(360px,85vw)}h1{font-size:40px;margin:0 0 12px}p{color:#b5bfb8;line-height:1.5}label{display:block;margin:20px 0 8px}input,select,button{box-sizing:border-box;width:100%;padding:13px;border-radius:8px;font:inherit}input,select{background:#1c2421;color:white;border:1px solid #536257}button{margin-top:24px;border:0;background:#c8edac;color:#152015;font-weight:700}.error{color:#ffb4a5}</style><main><h1>Bullwark</h1><p>Sign in to your team's live context dashboard.</p>${error?'<p class="error">That username or password did not match.</p>':''}<form method="post" action="/login"><input type="hidden" name="next" value="${destination}"><label for="username">Username</label><input id="username" name="username" value="team" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><label for="principal">Demo identity</label><select id="principal" name="principal">${Object.entries(roles).filter(([id])=>principalTokens[id]).map(([id,label])=>`<option value="${id}">${label}</option>`).join("")}</select><button type="submit">Open dashboard</button></form></main></html>`);
  }
  function proxy(req,res,target,keepAuth,principal) {
    const upstream = new URL(target);
    const headers = {...req.headers,host:upstream.host};
    delete headers.cookie;
    if (!keepAuth) {
      delete headers.authorization;
      if (principal && principalTokens[principal]) headers.authorization=`Bearer ${principalTokens[principal]}`;
    }
    const out = request(upstream,{method:req.method,path:req.url,headers}, incoming=>{
      res.writeHead(incoming.statusCode??502,incoming.headers);incoming.pipe(res);
    });
    out.on("error",()=>{if(!res.headersSent)res.writeHead(502,{"content-type":"text/plain"});res.end("Canon is starting. Please try again shortly.");});
    req.on("aborted",()=>out.destroy());res.on("close",()=>out.destroy());req.pipe(out);
  }
  return createServer(async (req,res)=>{
    res.setHeader("X-Robots-Tag","noindex, nofollow");
    let url;
    try {url=new URL(req.url,origin);} catch {res.writeHead(400).end();return;}
    const api = url.pathname.startsWith("/api/") || ["/mcp","/events","/health"].includes(url.pathname) || url.pathname.startsWith("/mcp/");
    if (req.method==="GET" && url.pathname==="/login") {login(res,"/");return;}
    if (req.method==="POST" && url.pathname==="/login") {
      if (req.headers.origin && req.headers.origin!==origin) {res.writeHead(403).end("Invalid origin");return;}
      let body="";
      try {for await(const chunk of req) {body+=chunk;if(body.length>4096){res.writeHead(413).end();return;}}}
      catch {res.writeHead(400).end();return;}
      const form=new URLSearchParams(body);
      if(!equal(form.get("username")??"","team") || !equal(form.get("password")??"",password)) {login(res,form.get("next"),true);return;}
      const principal=form.get("principal") || "wags";
      if (!Object.hasOwn(roles,principal) || !principalTokens[principal]) {res.writeHead(400).end("Choose a demo identity");return;}
      res.writeHead(303,{location:safeNext(form.get("next")),"set-cookie":`${COOKIE}=${session(principal)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE}${secure}`,"cache-control":"no-store"}).end();return;
    }
    if (api && req.method==="OPTIONS") {proxy(req,res,apiUrl,false);return;}
    const bearer = api && url.pathname!=="/health" && /^Bearer\s+\S+$/i.test(req.headers.authorization??"");
    const principal=authenticated(req);
    if (!bearer && !principal) {
      if(api)res.writeHead(401,{"content-type":"application/json","cache-control":"no-store"}).end(JSON.stringify({error:"Sign in to the Canon preview first."}));
      else login(res,url.pathname+url.search);
      return;
    }
    if (!bearer && api && !["GET","HEAD","OPTIONS"].includes(req.method) && req.headers.origin && req.headers.origin!==origin) {
      res.writeHead(403).end("Invalid origin");return;
    }
    if (["/","/index.html","/resume.html"].includes(url.pathname)) {
      const destination=principal==="wags" ? "/moderator.html" : "/member.html";
      res.writeHead(302,{location:destination,"cache-control":"no-store"}).end();return;
    }
    let staticPath;
    try { staticPath=posix.normalize(decodeURIComponent(url.pathname)); }
    catch {res.writeHead(400).end("Bad request");return;}
    // The moderator's optional mock bundle contains the entire synthetic world.
    // Do not deliver it through a member's preview session.
    if (!api && (/^\/moderator(?:[./-]|$)/.test(staticPath) || staticPath.startsWith("/bench/")) && principal!=="wags") {
      res.writeHead(404,{"cache-control":"no-store"}).end("Not found");return;
    }
    proxy(req,res,api?apiUrl:webUrl,bearer,api?principal:null);
  });
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const clients=new Map((process.env.CANON_CLIENT_TOKENS??"").split(",").map(pair=>{const at=pair.indexOf("=");return [pair.slice(0,at),pair.slice(at+1)];}));
  const principalTokens=Object.fromEntries(["wags","axe","ben","dollar-bill"].map(id=>[id,clients.get(id)]));
  const server=createPreviewGateway({password:process.env.PREVIEW_PASSWORD,publicUrl:process.env.PREVIEW_PUBLIC_URL??"http://localhost:8080",principalTokens});
  server.listen(4300,"127.0.0.1",()=>console.info("[preview] sign-in gateway ready"));
  const stop=()=>{server.closeAllConnections();server.close();};
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
}
