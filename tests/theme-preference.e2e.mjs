import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {join} from 'node:path';
import {root,launchOptions} from './browser-runtime.mjs';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
 const path=new URL(req.url).pathname;
 if(path==='/style.css'||path==='/workbench.css')return new Response(Bun.file(join(root,'public',path.slice(1))));
 if(/^\/client\/[a-z-]+\.js$/.test(path))return new Response(Bun.file(join(root,'src',path.slice(1))));
 return new Response('<!doctype html><html><head><meta name="theme-color"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"></head><body><select id="themeSelect"><option>system</option><option>light</option><option>dark</option></select><main class="conversation-shell"><section class="conversation"><article class="user-turn"><div class="user-message">Please review these changes. 中文消息也应清晰可读。</div><button class="user-message-copy">Copy</button></article></section><form class="composer"><textarea>Continue this task</textarea><button class="send-button">Send</button></form></main><script type="module">import{applyThemePreference}from"/client/theme.js";applyThemePreference();document.querySelector("#themeSelect").onchange=e=>applyThemePreference(e.target.value);window.ready=true;</script></body></html>',{headers:{'content-type':'text/html'}});
}});
const luminance=value=>value.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
let browser;const results=[];
try{
 browser=await chromium.launch({...launchOptions(),args:['--no-sandbox']});
 for(const system of ['light','dark'])for(const preference of ['light','dark','system']){
  const context=await browser.newContext({colorScheme:system,viewport:{width:1100,height:700}}),page=await context.newPage();
  await page.goto(server.url.href);await page.waitForFunction(()=>window.ready);
  await page.locator('#themeSelect').selectOption(preference);
  const actual=preference==='system'?system:preference;
  const colors=await page.evaluate(()=>{const root=getComputedStyle(document.documentElement),message=getComputedStyle(document.querySelector('.user-message')),send=getComputedStyle(document.querySelector('.send-button'));return{theme:document.documentElement.dataset.theme,canvas:root.getPropertyValue('--pf-canvas').trim(),background:message.backgroundColor,text:message.color,buttonBackground:send.backgroundColor,buttonText:send.color}});
  assert.equal(colors.theme,actual);
  assert.ok(contrast(colors.text,colors.background)>=7,JSON.stringify(colors));
  assert.ok(contrast(colors.buttonText,colors.buttonBackground)>=4.5,JSON.stringify(colors));
  if(actual==='light')assert.equal(colors.canvas,'#fff');
  else assert.ok(luminance(colors.background)<0.1);
  await page.reload();await page.waitForFunction(()=>window.ready);assert.equal(await page.locator('html').getAttribute('data-theme'),actual);
  results.push({system,preference,theme:actual,messageContrast:contrast(colors.text,colors.background)});
  await context.close();
 }
 console.log(JSON.stringify({passed:true,results},null,2));
}finally{await browser?.close();server.stop(true)}
