import { createBrowserFixture } from "./browser-runtime.mjs";
import assert from 'node:assert/strict';


import { launchOptions } from "./browser-runtime.mjs";

const runtime=await createBrowserFixture();
const port=Number(new URL(runtime.base).port),base=runtime.base;
let browser;
try{
  const compressed=await fetch(`${base}/app.bundle.js`,{headers:{...runtime.headers,'accept-encoding':'gzip'}});
  assert.equal(compressed.headers.get('content-encoding'),'gzip');
  assert.equal(compressed.headers.get('cache-control'),'private, no-cache');
  const bytes=Number(compressed.headers.get('content-length'));
  await compressed.arrayBuffer();
  assert.ok(bytes<400_000);
  const cached=await fetch(`${base}/app.bundle.js`,{headers:{...runtime.headers,'if-none-match':compressed.headers.get('etag')}});
  assert.equal(cached.status,304);
  assert.equal((await cached.arrayBuffer()).byteLength,0);
  assert.equal((await fetch(`${base}/api/config`,{headers:runtime.headers})).headers.get('cache-control'),'no-store');
  browser=await runtime.launchBrowser(launchOptions());
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let configuration;
  await page.route('**/api/config',route=>{configuration=route});
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>globalThis.__pandaForceDebug?.state.connected===true);
  assert.ok(configuration,'Connection starts before config returns');
  await configuration.continue();
  await page.unroute('**/api/config');
  await page.waitForFunction(()=>globalThis.__pandaForceDebug.state.config.defaultCwd);
  await page.waitForFunction(()=>globalThis.__pandaForceDebug.state.modelLoadStatus==='ready');
  // Permission profiles and models may be slow; the session list must render first.
  await page.evaluate(()=>{
    const api=globalThis.__pandaForceDebug;
    if(api.state.ws)api.state.ws.onmessage=null;
    api.state.events?.close();api.state.transport='sse';
    const original=window.fetch;
    window.__startupPending=new Map();
    window.__startupListFails=false;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname!=='/api/rpc')return original(resource,options);
      const call=JSON.parse(options.body);
      if(call.method==='thread/list'){
        if(window.__startupListFails)return Response.json({type:'rpc/error',id:call.id,error:'Session list unavailable'});
        return Response.json({type:'rpc/result',id:call.id,result:{data:[{id:'fast-session',name:'Session ready before models',cwd:api.state.config.defaultCwd,status:{type:'idle'},updatedAt:Date.now()/1000}]}});
      }
      return new Promise(resolve=>window.__startupPending.set(call.method,()=>resolve(Response.json({type:'rpc/result',id:call.id,result:{data:call.method==='model/list'?[api.state.models[0]]:[]}}))));
    };
    window.__startupLoad=api.loadInitial();
  });
  await page.waitForSelector('.thread-item[data-id="fast-session"]');
  await page.waitForFunction(()=>window.__startupPending.has('model/list')&&window.__startupPending.has('permissionProfile/list'));
  await page.evaluate(async()=>{for(const resolve of window.__startupPending.values())resolve();await window.__startupLoad});
  // A session-list failure must not prevent models or permissions loading.
  await page.evaluate(()=>{window.__startupListFails=true;window.__startupPending.clear();globalThis.__pandaForceDebug.state.threads=[];window.__startupLoad=globalThis.__pandaForceDebug.loadInitial()});
  await page.waitForFunction(()=>window.__startupPending.has('model/list')&&window.__startupPending.has('permissionProfile/list'));
  await page.evaluate(async()=>{for(const resolve of window.__startupPending.values())resolve();await window.__startupLoad});
  await page.waitForSelector('.thread-item[data-id="fast-session"]');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({gzipBytes:bytes,cacheRevalidation:304,configAndConnectionParallel:true,independentSessionLoading:true}));
}finally{
  await browser?.close();await runtime.dispose();
}
