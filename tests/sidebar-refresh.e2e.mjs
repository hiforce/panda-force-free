import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from './browser-runtime.mjs';
import { createProjectVisibilityFixture, waitFor } from './project-visibility-fixture.mjs';

const fixture=await createProjectVisibilityFixture();
let browser,stage='startup';
try{
 browser=await chromium.launch(launchOptions());
 const context=await browser.newContext();
 await fixture.signIn(context);
 await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
 const page=await context.newPage(),errors=[],prefetched=new Set();
 page.on('pageerror',error=>errors.push(error.message));
 let bundle;
 await page.route('**/app.bundle.js',route=>{bundle=route});
 await page.route('**/api/config',route=>{prefetched.add('config');return route.continue()});
 await page.route('**/api/projects/visibility',route=>{prefetched.add('visibility');return route.continue()});
 await page.route('**/api/rpc',route=>{if(route.request().postDataJSON().method==='thread/list')prefetched.add('threads');return route.continue()});
 await page.goto(fixture.base,{waitUntil:'domcontentloaded'});
 await waitFor(()=>bundle&&prefetched.size===3);
 assert.equal(await page.evaluate(()=>Boolean(globalThis.__codexWebuiDebug)),false,'API reads must start before the main bundle is evaluated');
 await bundle.continue();await page.unroute('**/app.bundle.js');
 await page.locator('.thread-item[data-id="old-alpha"]').waitFor();
 assert.equal(await page.evaluate(()=>performance.getEntriesByType('resource').some(entry=>/file-preview\.bundle|terminal-runtime\.bundle/.test(entry.name))),false);
 await fixture.visibility({project:fixture.beta,hidden:true});
 await page.waitForFunction(beta=>JSON.parse(localStorage.getItem('codex-webui-sidebar-snapshot-v1'))?.visibility.hiddenProjects[beta],fixture.beta);
 const snapshot=await page.evaluate(()=>JSON.parse(localStorage.getItem('codex-webui-sidebar-snapshot-v1')));
 assert.equal(snapshot.threads.length,3);
 // Simulate slow IndexedDB and a bridge that cannot connect yet. The sidebar
 // should remain usable from its small independent snapshot.
 await context.addInitScript(()=>{
  if(window!==window.top)return;
  const open=indexedDB.open.bind(indexedDB);
  indexedDB.open=(...args)=>{
   const result={};
   setTimeout(()=>{const actual=open(...args);for(const name of ['onsuccess','onerror','onblocked','onupgradeneeded'])actual[name]=event=>{
    if(name==='onsuccess'||name==='onupgradeneeded')result.result=actual.result;
    if(name==='onerror')result.error=actual.error;
    result[name]?.(event);
   }},5000);
   return result;
  };
  window.WebSocket=class{static OPEN=1;constructor(){this.readyState=0}send(){}close(){this.readyState=3}};
 });
 await page.unroute('**/api/config');await page.unroute('**/api/projects/visibility');await page.unroute('**/api/rpc');
 const held=[],heldReads=new Set();let events;
 await page.route('**/api/events',route=>{events=route});
 for(const path of ['config','projects/visibility'])await page.route(`**/api/${path}`,async route=>{
  const response=await route.fetch();heldReads.add(path);held.push(()=>route.fulfill({response}));
 });
 await page.route('**/api/rpc',async route=>{
  const call=route.request().postDataJSON();if(call.method!=='thread/list')return route.continue();
  const response=await route.fetch(),body=await response.json();
  body.result.data.find(thread=>thread.id==='old-alpha').name='Fresh alpha session';
  heldReads.add('threads');held.push(()=>route.fulfill({json:body}));
 });
 stage='cached sidebar with fresh reads held';
 const start=performance.now();await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('.sidebar-project-group').first().waitFor({timeout:2000});
 await page.locator('.thread-item[data-id="old-alpha"]').waitFor({timeout:2000});
 const cachedSidebarMs=Math.round(performance.now()-start);
 assert.equal(await page.locator(`.sidebar-project-group[data-project="${fixture.beta}"]`).count(),0,'Cached hidden projects must stay hidden');
 assert.equal(await page.evaluate(()=>globalThis.__codexWebuiDebug.state.connected),false);
 assert.equal(await page.locator('.thread-item[data-id="old-alpha"] .thread-name').textContent(),'Old alpha session');
 await waitFor(()=>heldReads.size===3);
 // A newer push must win over an older visibility HTTP response captured above.
 await fixture.visibility({project:fixture.beta,hidden:false});
 await waitFor(()=>events);await events.continue();await page.unroute('**/api/events');
 await page.locator(`.sidebar-project-group[data-project="${fixture.beta}"]`).waitFor();
 stage='background revalidation';
 await Promise.all(held.map(release=>release()));
 await page.waitForFunction(()=>document.querySelector('.thread-item[data-id="old-alpha"] .thread-name')?.textContent==='Fresh alpha session');
 assert.equal(await page.locator(`.sidebar-project-group[data-project="${fixture.beta}"]`).count(),1);
 await page.evaluate(()=>{const api=globalThis.__codexWebuiDebug;api.applyThreadSummaries(api.state.threads.map(thread=>thread.id==='old-alpha'?{...thread,name:'Renamed elsewhere'}:thread))});
 assert.equal(await page.locator('.thread-item[data-id="old-alpha"] .thread-name').textContent(),'Renamed elsewhere');
 // The deferred viewer must use the same private attachment routing as the main app.
 stage='deferred file preview';
 const prefix='https://private-bucket.oss-eu-central-1.aliyuncs.com/codex-webui/attachments/';
 const markdown=join(fixture.alpha,'managed-images.md');
 writeFileSync(markdown,`# Managed images\n\n![Reference](${prefix}test/reference.png)`);
 const png=readFileSync(new URL('../public/assets/panda-icon.png',import.meta.url));
 await page.route('**/api/attachments/read?*',route=>route.fulfill({contentType:'image/png',body:png}));
 await page.evaluate(({prefix,markdown,cwd})=>{
  const api=globalThis.__codexWebuiDebug;api.state.config.attachmentUrlPrefix=prefix;
  api.state.active={id:'old-alpha',cwd,turns:[]};
  api.notify('item/completed',{turnId:'preview-turn',item:{id:'preview-link',type:'agentMessage',phase:'final_answer',text:`[Open managed image file](${markdown})`}});
 },{prefix,markdown,cwd:fixture.alpha});
 await page.locator(`a[data-file-reference="${markdown}"]`).click();
 await page.waitForFunction(()=>document.querySelector('#filePreview .message-image')?.naturalWidth>0);
 assert.ok((await page.locator('#filePreview .message-image').getAttribute('src')).startsWith('/api/attachments/read?'));
 await page.locator('#closeFilePreview').click();
 await page.evaluate(()=>dispatchEvent(new Event('codex-webui:logged-out')));
 assert.equal(await page.evaluate(()=>localStorage.getItem('codex-webui-sidebar-snapshot-v1')),null);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({apiPrefetchBeforeBundle:true,cachedSidebarMs,indexedDBDelayMs:5000,visibleBeforeNetwork:true,hiddenProjectPreserved:true,newerPushWins:true,backgroundRevalidation:true,lazyViewerUsesPrivateAttachmentUrls:true,logoutClearsSnapshot:true}));
}catch(error){console.error('Sidebar refresh failure:',stage);throw error}
finally{await browser?.close();await fixture.dispose()}
