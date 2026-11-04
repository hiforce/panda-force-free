import { chromium } from 'playwright';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { launchOptions } from './browser-runtime.mjs';

const temp=mkdtempSync(join(tmpdir(),'webui-idaas-browser-')),bin=join(temp,'bin');mkdirSync(bin);
writeFileSync(join(bin,'codex'),'#!/usr/bin/env node\nprocess.stdin.resume();\n',{mode:0o700});
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));const base=`http://127.0.0.1:${port}`;
let account='owner';
const codes=new Map(),authorizations=[];let logoutCount=0;
const validateAuthorization=url=>{
 assert.equal(url.searchParams.get('client_id'),'browser-test');
 assert.equal(url.searchParams.get('redirect_uri'),base+'/auth/callback');
 assert.equal(url.searchParams.get('protocol'),'oidc');
 assert.equal(url.searchParams.get('response_type'),'code');
 assert.equal(url.searchParams.get('response_mode'),'query');
 assert.equal(url.searchParams.get('scope'),'user');
 assert.ok(url.searchParams.get('state'));assert.ok(url.searchParams.get('nonce'));
};
const issueCode=(url,identity)=>{
 const code=crypto.randomUUID();codes.set(code,identity);
 const next=new URL(url.searchParams.get('redirect_uri'));next.searchParams.set('code',code);next.searchParams.set('state',url.searchParams.get('state'));
 const headers=new Headers({location:next.href});
 headers.append('set-cookie',`test_idaas_sso=${identity}; Path=/; HttpOnly; SameSite=Lax`);
 headers.append('set-cookie','test_idaas_reauthenticate=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
 return new Response(null,{status:302,headers});
};
const idaas=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
 const url=new URL(req.url);
 if(url.pathname==='/oidc/auth'){
  validateAuthorization(url);authorizations.push(new URL(url));
  const cookies=req.headers.get('cookie')||'',identity=cookies.match(/(?:^|;\s*)test_idaas_sso=([^;]+)/)?.[1];
  if(identity)return issueCode(url,identity);
  if(cookies.includes('test_idaas_reauthenticate=1'))return new Response(`<form method="post" action="/test-sign-in?${url.searchParams.toString().replaceAll('&','&amp;')}"><h1>IDAAS sign in</h1><button name="account" value="owner">Sign in as owner</button></form>`,{headers:{'content-type':'text/html;charset=utf-8'}});
  return issueCode(url,account);
 }
 if(url.pathname==='/test-sign-in'){
  validateAuthorization(url);assert.equal(req.method,'POST');
  const identity=new URLSearchParams(await req.text()).get('account');assert.equal(identity,'owner');
  return issueCode(url,identity);
 }
 if(url.pathname==='/logout'){
  assert.equal(url.searchParams.get('redirectUri'),base+'/auth/login');assert.equal(url.searchParams.has('redirect_uri'),false);logoutCount++;
  const headers=new Headers({location:url.searchParams.get('redirectUri')});
  headers.append('set-cookie','test_idaas_sso=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  headers.append('set-cookie','test_idaas_reauthenticate=1; Path=/; HttpOnly; SameSite=Lax');
  return new Response(null,{status:302,headers});
 }
 if(url.pathname==='/oidc/token'){
  const body=await req.json(),identity=codes.get(body.code);assert.ok(identity);codes.delete(body.code);
  assert.equal(body.redirect_uri,base+'/auth/callback');
  return Response.json({success:true,data:{access_token:`browser-test-token-${identity}`,expires_in:120,id_token:'browser-test-id'}});
 }
 if(url.pathname==='/oidc/token/introspection')return Response.json({active:true,exp:Math.floor(Date.now()/1000)+120});
 if(url.pathname==='/oidc/me')return Response.json({success:true,data:{uuid:'owner',account:req.headers.get('authorization').slice('Bearer browser-test-token-'.length),tenantId:42}});
 return new Response('Not found',{status:404});
}});
const child=Bun.spawn(['bun','run','src/server/main.ts'],{cwd:new URL('..',import.meta.url).pathname,env:{...process.env,NODE_ENV:'production',PATH:`${bin}:${process.env.PATH}`,HOME:temp,CODEX_HOME:temp,PANDA_FORCE_HOME:join(temp,'panda-state'),HOST:'127.0.0.1',PORT:String(port),CODEX_WEBUI_PROJECTLESS:'false',CODEX_WEBUI_CWD:temp,CODEX_WEBUI_AUTH_MODE:'idaas',IDAAS_AUTH_ENDPOINT:idaas.url.origin,IDAAS_BROWSER_ENDPOINT:idaas.url.origin,IDAAS_CLIENT_ID:'browser-test',IDAAS_CLIENT_SECRET:'test-only',CODEX_WEBUI_PUBLIC_URL:base,IDAAS_ALLOWED_TENANT_IDS:'42',IDAAS_ALLOWED_ACCOUNTS:'owner'},stdout:'ignore',stderr:'pipe'});
let browser;
try{
 let ready=false; for(let n=0;n<300;n++){try{if((await fetch(base+'/health/startup')).ok){ready=true;break}}catch{}if(child.exitCode!==null)throw new Error(await new Response(child.stderr).text());await Bun.sleep(30)} if(!ready)throw new Error('IDAAS test server did not start');
 const options=launchOptions();if(!options.executablePath&&existsSync('/usr/bin/google-chrome'))options.executablePath='/usr/bin/google-chrome';
 browser=await chromium.launch({...options,args:['--no-sandbox']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(origin=>{if(window.top!==window||location.origin!==origin)return;localStorage.setItem('codex-webui-project','/home/codex/workspace');localStorage.setItem('codex-webui-active-thread','old-isolated-runtime-thread')},base);
 const workspaceRequests=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/workspace/context')workspaceRequests.push(url.searchParams.get('cwd'))});
 await page.goto(base);await page.waitForSelector('#webuiLogout',{state:'attached'});
 const status=await page.evaluate(()=>fetch('/api/auth/status').then(r=>r.json()));assert.equal(status.authMode,'idaas');assert.equal(status.authenticated,true);
 assert.equal(await page.locator('#passwordGate').isVisible(),false);
 await page.waitForFunction(expected=>localStorage.getItem('codex-webui-project')===expected,temp);
 assert.equal(await page.evaluate(()=>localStorage.getItem('codex-webui-active-thread')),null);
 assert.equal(workspaceRequests.includes('/home/codex/workspace'),false);
 // Background checks and expiry must never navigate away from the working page.
 const returnPath='/new?from=session-check#draft';
 await page.goto(base+returnPath);await page.locator('#webuiLogout').waitFor({state:'attached'});
 await page.waitForFunction(expected=>localStorage.getItem('codex-webui-project')===expected,temp);
 await page.locator('#workspacePreparationContinue').click();
 assert.equal(await page.locator('#workspacePreparation').isVisible(),false);
 const draft='Keep this unsent draft across authentication';
 await page.evaluate(text=>{
  window.__sessionTestDocument='original-document';
  const prompt=document.querySelector('#prompt');prompt.value=text;prompt.dispatchEvent(new Event('input',{bubbles:true}));
 },draft);
 const navigations=[],initialAuthorizations=authorizations.length;
 const trackNavigation=frame=>{if(frame===page.mainFrame())navigations.push(frame.url())};
 page.on('framenavigated',trackNavigation);
 const verify=()=>page.evaluate(()=>globalThis.__codexWebuiCheckAuth({force:true}));
 await verify();await verify();
 await page.route('**/api/auth/status',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Authentication temporarily unavailable"}'}));
 await verify();await page.locator('#webuiSessionNotice[data-status="unavailable"]').waitFor();
 assert.equal(await page.locator('#prompt').inputValue(),draft);
 assert.equal(page.url(),base+returnPath);assert.equal(navigations.length,0);
 await page.unroute('**/api/auth/status');await verify();
 assert.equal(await page.locator('#webuiSessionNotice').isVisible(),false);
 // An actual server-side logout models definitive expiry, including closed channels.
 assert.equal((await page.request.post(base+'/api/auth/logout')).status(),200);
 await verify();await page.locator('#webuiSessionNotice[data-status="expired"]').waitFor();
 assert.equal((await page.request.get(base+'/api/config')).status(),401);
 assert.equal(await page.locator('#prompt').inputValue(),draft);
 assert.equal(await page.evaluate(()=>window.__sessionTestDocument),'original-document');
 assert.equal(await page.locator('#workspacePreparation').isVisible(),false);
 assert.equal(navigations.length,0);assert.equal(authorizations.length,initialAuthorizations);
 await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('zh-CN'));
 await page.getByRole('button',{name:'重新登录',exact:true}).waitFor();
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 mkdirSync('.artifacts',{recursive:true});await page.screenshot({path:'.artifacts/auth-session-background.png'});
 await page.evaluate(()=>globalThis.__codexWebuiI18n.setPreference('en'));
 await page.route('**/api/auth/status',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
 await verify();assert.equal(await page.locator('#webuiSessionNotice').getAttribute('data-status'),'expired');
 await page.unroute('**/api/auth/status');
 // Only this explicit click starts OAuth; state must restore path, query, fragment and draft.
 await page.getByRole('button',{name:'Sign in again',exact:true}).click();
 await page.waitForFunction(()=>window.__sessionTestDocument===undefined);
 await page.waitForURL(base+returnPath);await page.locator('#webuiLogout').waitFor({state:'attached'});
 await page.waitForFunction(text=>document.querySelector('#prompt')?.value===text,draft);
 page.off('framenavigated',trackNavigation);
 if(await page.locator('#workspacePreparation').isVisible())await page.locator('#workspacePreparationContinue').click();await page.locator('#accountButton').click();await page.locator('#webuiLogout').click();await page.waitForURL('**/auth/logged-out');
 await page.getByRole('heading',{level:1,name:'See you next time'}).waitFor();
 assert.equal((await page.request.get(base+'/api/config')).status(),401);assert.deepEqual(errors,[]);
 // A denied identity must receive a self-contained document, with no app access.
 account='not-authorized';mkdirSync('.artifacts',{recursive:true});
 const deniedContext=await browser.newContext({locale:'zh-CN',viewport:{width:1280,height:900}});
 const denied=await deniedContext.newPage(),requests=[];
 denied.on('request',request=>requests.push(new URL(request.url()).pathname));
 const deniedResponse=await denied.goto(base);
 assert.equal(deniedResponse.status(),403);
 assert.ok(deniedResponse.headers()['content-type'].includes('text/html'));
 await denied.getByRole('heading',{level:1,name:'暂时无法访问'}).waitFor();
 assert.equal(await denied.locator('.brand').textContent(),'PandaForce');
 assert.ok((await denied.title()).includes('PandaForce'));
 assert.equal(await denied.locator('form').getAttribute('action'),'/auth/relogin');
 assert.equal(await denied.locator('form').getAttribute('method'),'post');
 assert.equal(requests.includes('/app.bundle.js'),false);
 assert.equal((await deniedContext.request.get(base+'/api/config')).status(),401);
 assert.equal((await denied.locator('body').textContent()).includes('browser-test-token'),false);
 await denied.screenshot({path:'.artifacts/auth-denied-desktop.png'});
 const light=await denied.locator('body').evaluate(node=>getComputedStyle(node).backgroundColor);
 await denied.emulateMedia({colorScheme:'dark'});
 assert.notEqual(await denied.locator('body').evaluate(node=>getComputedStyle(node).backgroundColor),light);
 await denied.screenshot({path:'.artifacts/auth-denied-dark.png'});
 await denied.emulateMedia({colorScheme:'light'});await denied.setViewportSize({width:390,height:844});
 assert.equal(await denied.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.ok((await denied.locator('.action').boundingBox()).height>=44);
 await denied.keyboard.press('Tab');
 assert.equal(await denied.locator('.action').evaluate(node=>node===document.activeElement),true);
 await denied.screenshot({path:'.artifacts/auth-denied-mobile.png'});
 // Reissuing authorization alone must keep using the old SSO identity. This
 // reproduces the real failure even after a different account becomes available.
 account='owner';assert.equal((await denied.goto(base+'/auth/login')).status(),403);
 const stale=authorizations.at(-1);
 await denied.getByRole('button',{name:'重新登录'}).click();
 await denied.getByRole('heading',{name:'IDAAS sign in'}).waitFor();
 assert.equal(logoutCount,1);
 assert.equal(new URL(denied.url()).origin,idaas.url.origin);
 const fresh=authorizations.at(-1);
 assert.notEqual(fresh.searchParams.get('state'),stale.searchParams.get('state'));
 assert.notEqual(fresh.searchParams.get('nonce'),stale.searchParams.get('nonce'));
 assert.equal((await deniedContext.request.get(base+'/api/config')).status(),401);
 await denied.getByRole('button',{name:'Sign in as owner'}).click();
 await denied.locator('#webuiLogout').waitFor({state:'attached'});
 assert.equal(new URL(denied.url()).origin,base);assert.equal(new URL(denied.url()).pathname,'/');
 assert.equal((await deniedContext.request.get(base+'/api/auth/status')).ok(),true);
 await deniedContext.close();
 account='not-authorized';
 const noScript=await browser.newContext({locale:'en',javaScriptEnabled:false});
 const fallback=await noScript.newPage();assert.equal((await fallback.goto(base)).status(),403);
 await fallback.getByRole('heading',{level:1,name:'This account needs access'}).waitFor();
 await fallback.screenshot({path:'.artifacts/auth-denied-english.png'});
 await fallback.goto(base+'/auth/callback?code=expired');
 await fallback.getByRole('heading',{level:1,name:"Let's try signing in again"}).waitFor();
 await noScript.close();
 console.log('Browser IDAAS background verification, transient recovery, definitive expiry without navigation, retained drafts, explicit relogin to the original route, login/logout, persistent SSO denial, callback parameters, API protection, localization and responsive pages passed.');
}finally{await browser?.close();child.kill('SIGTERM');await child.exited;idaas.stop(true);rmSync(temp,{recursive:true,force:true})}
