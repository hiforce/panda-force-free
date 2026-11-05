import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createAppFixture} from './app-fixture.mjs';
const fixture=await createAppFixture();
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await fixture.signIn(context);
 await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('panda-force-locale','en')});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(fixture.base+'/task/old-alpha');await page.locator('#workspacePreparation').waitFor({state:'hidden'});
 const states=await page.evaluate(()=>{
  const api=globalThis.__pandaForceDebug,id='old-alpha',result=[];
  const take=stage=>{api.renderHeader();api.refreshThreadRowMetadata();result.push({stage,status:document.querySelector('#sessionStatus').dataset.state,label:document.querySelector('#sessionStatus').textContent.trim(),sidebar:document.querySelector('.thread-item[data-id="old-alpha"]')?.dataset.running})};
  api.syncTurnSnapshot({id:'old-turn',status:'completed',items:[{id:'old-answer',type:'agentMessage',text:'Previous reply'}]});take('completed baseline');
  api.notify('thread/status/changed',{threadId:id,status:{type:'active'}});take('active native status with old completed history');
  api.notify('thread/status/changed',{threadId:id,status:{type:'idle'}});
  api.state.active.turns.push({id:'new-turn',status:'inProgress',items:[]});take('new empty turn with old runtime completion');
  api.syncTurnSnapshot({id:'new-turn',status:'inProgress',items:[]});
  api.notify('turn/completed',{threadId:id,turn:{id:'old-turn',status:'completed',items:[]}});take('late older completion');
  api.notify('turn/completed',{threadId:id,turn:{id:'new-turn',status:'completed',items:[]}});take('actual latest completion');
  api.notify('turn/started',{threadId:id,turn:{id:'third-turn',status:'inProgress',items:[]}});take('next turn before history catches up');
  api.notify('turn/completed',{threadId:id,turn:{id:'third-turn',status:'completed',items:[]}});take('next turn completed');
  return result;
 });
 assert.deepEqual(states.map(item=>item.status),['completed','running','running','running','completed','running','completed']);
 assert.deepEqual(states.map(item=>item.sidebar),['false','true','true','true','false','true','false']);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({states,errors}));
}finally{await browser.close();await fixture.dispose();}
