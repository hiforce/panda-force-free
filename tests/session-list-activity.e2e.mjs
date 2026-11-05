import { createBrowserFixture } from "./browser-runtime.mjs";
import assert from 'node:assert/strict';


import { artifact, launchOptions } from "./browser-runtime.mjs";

const runtime=await createBrowserFixture();
const port=Number(new URL(runtime.base).port),base=runtime.base;
let browser;
try{
  browser=await runtime.launchBrowser(launchOptions());
  const context=await browser.newContext({viewport:{width:1018,height:760}});
  await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('panda-force-locale','en')});
  const page=await context.newPage(),errors=[];
  const originalWait=page.waitForFunction.bind(page);page.waitForFunction=async(...args)=>{try{return await originalWait(...args)}catch(error){console.error('Wait failed:',String(args[0]));throw error}};
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__pandaForceDebug?.applyThreadSummaries);
  await page.evaluate(()=>{
    const api=globalThis.__pandaForceDebug;
    if(api.state.ws)api.state.ws.onmessage=null;
    api.state.events?.close();
    api.state.transport='sse';
    const original=window.fetch;
    window.fetch=async(resource,options={})=>{
      const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
      if(url.pathname!=='/api/rpc')return original(resource,options);
      const call=JSON.parse(options.body);
      window.__activityCalls??=[];window.__activityCalls.push(call);
      if(call.method==='thread/goal/set'){
        if(window.__goalSaveFails)return Response.json({type:'rpc/error',id:call.id,error:'Goal save failed'});
        const goal=api.state.goals.get(call.params.threadId);
        return Response.json({type:'rpc/result',id:call.id,result:{goal:{...goal,objective:call.params.objective,updatedAt:Date.now()}}});
      }
      if(call.method==='thread/name/set')return Response.json({type:'rpc/result',id:call.id,result:{thread:{id:call.params.threadId,name:call.params.name}}});
      return Response.json({type:'rpc/result',id:call.id,result:{data:window.__activityThreads,thread:window.__activityThreads.find(thread=>thread.id===call.params.threadId)}});
    };
    window.__activityNow=Date.now();Date.now=()=>window.__activityNow;
    const now=Date.now()/1000,cwd=api.state.config.defaultCwd;
    window.__activityThreads=[
      {id:'running',name:'A very long session name to verify truncation and visible metadata',cwd,status:{type:'active'},updatedAt:now-300},
      {id:'idle',name:'Idle session',cwd,model:'gpt-6.1-sol',modelProvider:'openai',reasoningEffort:'high',status:{type:'idle'},updatedAt:now-7200},
      {id:'unknown',name:'Session without timestamps',cwd,status:{type:'notLoaded'}},
    ];
    (api.state.active={id:'idle',cwd,turns:[]}, api.workbench.threadOpened(api.state.active.id));
    api.applyThreadSummaries(window.__activityThreads);
    api.setSidebarOpen(true);
  });
  const row=id=>page.locator(`.thread-item[data-id="${id}"]`);
  const togglePin=async group=>{await group.locator('.sidebar-project-options').click();await page.locator('.sidebar-project-menu button').nth(1).click()};
  assert.equal(await row('running').getAttribute('data-running'),'true');
  assert.equal(await row('running').locator('time').textContent(),'5 min. ago');
  assert.equal(await row('running').locator('.thread-running').isVisible(),true);
  assert.equal(await row('running').locator('.thread-running').getAttribute('aria-label'),'In progress');
  assert.equal(await row('idle').locator('.thread-running').isVisible(),false);
  assert.equal(await row('idle').locator('time').textContent(),'2 hr. ago');
  assert.equal(await row('unknown').locator('time').textContent(),'—');
  assert.equal(await row('unknown').locator('time').getAttribute('datetime'),null);
  await page.evaluate(()=>{globalThis.__pandaForceDebug.state.active=globalThis.__pandaForceDebug.state.threads.find(thread=>thread.id==='idle');globalThis.__pandaForceDebug.workbench.threadOpened('idle')});
  await page.evaluate(()=>globalThis.__pandaForceDebug.renderHeader?.());
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'idle');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('goal/status/changed',{threadId:'idle',goalId:'goal-1',status:'active',objective:'Complete the validation',updatedAt:100}));
  assert.equal(await page.locator('#goalStatus').getAttribute('data-state'),'active');
  assert.equal(await page.locator('#goalDialog').isVisible().catch(()=>false),false);
  await page.locator('#goalStatus .goal-status-toggle').click();
  assert.equal(await page.locator('#goalDialog').isVisible(),true);
  assert.equal(await page.locator('#goalDialogObjective').inputValue(),'Complete the validation');
  await page.locator('#cancelGoalDialog').click();
  assert.equal(await page.locator('#goalDialog').isVisible().catch(()=>false),false);
  await page.locator('#goalStatus .goal-status-toggle').click();
  await page.locator('#goalDialogObjective').fill('Revised validation objective');
  await page.evaluate(()=>window.__goalSaveFails=true);
  await page.locator('#saveGoalDialog').click();
  await page.locator('#goalDialogError').waitFor({state:'visible'});
  assert.equal(await page.locator('#goalDialogObjective').inputValue(),'Revised validation objective');
  await page.evaluate(()=>window.__goalSaveFails=false);
  await page.locator('#saveGoalDialog').click();
  await page.waitForFunction(()=>!document.querySelector('#goalDialog').open);
  await page.locator('#goalStatus .goal-status-toggle').click();
  assert.equal(await page.locator('#goalDialogObjective').inputValue(),'Revised validation objective');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#goalDialog').isVisible(),false);
  // Subsequent protocol fixtures have independent timestamps.
  await page.evaluate(()=>globalThis.__pandaForceDebug.state.goals.get('idle').updatedAt=100000);
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('goal/progress',{threadId:'idle',goalId:'goal-1',message:'P2 in progress',progress:{completed:2,total:4},updatedAt:101}));
  assert.equal((await page.locator('#goalStatus').textContent()).includes('P2 in progress'),false);
  assert.equal((await page.locator('#goalStatus').textContent()).includes('2/4'),true);
  await page.locator('#goalStatus .goal-status-toggle').click();
  assert.equal((await page.locator('#goalDialogDetail').textContent()).includes('P2 in progress'),true);
  await page.locator('#cancelGoalDialog').click();
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('goal/status/changed',{threadId:'idle',goalId:'goal-1',status:'blocked',detail:'old event',updatedAt:99}));
  assert.equal(await page.locator('#goalStatus').getAttribute('data-state'),'active');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('goal/status/changed',{threadId:'idle',goalId:'goal-1',status:'completed',detail:'All checks passed',updatedAt:102}));
  assert.equal(await page.locator('#goalStatus').getAttribute('data-state'),'completed');
  await page.locator('#goalStatus .goal-status-toggle').click();
  assert.equal((await page.locator('#goalDialogDetail').textContent()).includes('All checks passed'),true);
  await page.locator('#cancelGoalDialog').click();
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('goal/status/changed',{threadId:'running',goalId:'goal-2',status:'active',objective:'Background goal',updatedAt:103}));
  assert.equal(await page.locator('#goalStatus').getAttribute('data-state'),'completed');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/started',{threadId:'idle',turn:{id:'status-turn'}}));
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'running');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/completed',{threadId:'idle',turn:{id:'status-turn',status:'completed'}}));
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'completed');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/started',{threadId:'idle',turn:{id:'status-error'}}));
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('error',{threadId:'idle',turnId:'status-error',error:{message:'Selected model is at capacity'}}));
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'running');
  assert.equal(await page.locator('#persistentErrors [data-error-id]').count(),0);
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/completed',{threadId:'idle',turn:{id:'status-error',status:'failed',error:{message:'Selected model is at capacity'}}}));
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'error');
  assert.equal((await page.locator('[data-thread-error]').textContent()).includes('Selected model is at capacity'),true);
  assert.equal(await page.locator('#persistentErrors [data-error-id]').count(),0);
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/started',{threadId:'idle',turn:{id:'status-recovery'}}));
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'running');
  assert.equal(await page.locator('[data-thread-error]').count(),0);
  await page.evaluate(()=>{
    const api=globalThis.__pandaForceDebug,stale={...api.state.threads.find(thread=>thread.id==='idle'),status:{type:'active'},lastError:{message:'Selected model is at capacity'}};
    api.applyThreadSummaries(api.state.threads.map(thread=>thread.id==='idle'?stale:thread));
  });
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'running');
  assert.equal(await row('idle').getAttribute('data-error'),'false');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/completed',{threadId:'idle',turn:{id:'status-recovery',status:'completed'}}));
  await page.evaluate(()=>{const api=globalThis.__pandaForceDebug,thread=api.state.active;thread.lastError={message:'Selected model is at capacity'};thread.error=thread.lastError;api.renderHeader()});
  assert.equal(await page.locator('#sessionStatus').getAttribute('data-state'),'completed');
  await page.evaluate(()=>globalThis.__pandaForceDebug.applyThreadSummaries(window.__activityThreads));
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/started',{threadId:'idle',turn:{id:'status-generic-failure'}}));
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/completed',{threadId:'idle',turn:{id:'status-generic-failure',status:'failed'}}));
  assert.equal(await page.locator('#sessionStatus').textContent(),'Task failed');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/started',{threadId:'idle',turn:{id:'status-generic-recovery'}}));
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/completed',{threadId:'idle',turn:{id:'status-generic-recovery',status:'completed'}}));
  const fits=await row('running').evaluate(node=>{
    const spinner=node.querySelector('.thread-running').getBoundingClientRect(),name=node.querySelector('.thread-name').getBoundingClientRect(),meta=node.querySelector('.thread-meta').getBoundingClientRect(),options=node.querySelector('.thread-options').getBoundingClientRect();
    return node.firstElementChild.classList.contains('thread-running')&&spinner.left>=node.getBoundingClientRect().left&&spinner.right<name.left&&name.width>0&&name.right<=meta.left&&meta.right<=options.left&&options.right<=node.getBoundingClientRect().right;
  });
  assert.equal(fits,true);
  await page.screenshot({path:artifact('session-list-activity.png')});
  // Unchanged server summaries must still advance time without replacing rows.
  await page.evaluate(()=>{window.__originalActivityRow=document.querySelector('.thread-item[data-id="running"]');window.__activityNow+=120_000;globalThis.__pandaForceDebug.applyThreadSummaries(window.__activityThreads)});
  assert.equal(await row('running').locator('time').textContent(),'7 min. ago');
  assert.equal(await page.evaluate(()=>window.__originalActivityRow===document.querySelector('.thread-item[data-id="running"]')),true);
  const unchanged=await page.evaluate(()=>{
    const api=globalThis.__pandaForceDebug,before=document.querySelector('#conversation').innerHTML;
    api.notify('turn/started',{threadId:'running',turn:{id:'new-running-turn'}});
    api.notify('turn/completed',{threadId:'running',turn:{id:'old-running-turn'}});
    return before===document.querySelector('#conversation').innerHTML;
  });
  assert.equal(unchanged,true);
  assert.equal(await row('running').getAttribute('data-running'),'true');
  assert.equal(await row('running').locator('time').textContent(),'now');
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('thread/status/changed',{threadId:'running',status:{type:'idle'}}));
  assert.equal(await row('running').locator('.thread-running').isVisible(),true);
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('turn/completed',{threadId:'running',turn:{id:'new-running-turn',status:'completed'}}));
  assert.equal(await row('running').locator('.thread-running').isVisible(),false);
  await page.evaluate(()=>globalThis.__pandaForceDebug.notify('thread/status/changed',{threadId:'unknown',status:{type:'active'}}));
  assert.equal(await row('unknown').locator('.thread-running').isVisible(),true);

  // A successful turn must clear a previous turn-level error on the same session.
  await page.evaluate(()=>{
    const api=globalThis.__pandaForceDebug;
    const thread={id:'recovered',name:'Recovered session',cwd:api.state.config.defaultCwd,status:{type:'idle'},updatedAt:Date.now()/1000};
    api.state.threads.push(thread);api.renderThreads();
    api.notify('error',{threadId:'recovered',error:{message:'Selected model is at capacity'}});
    api.notify('turn/completed',{threadId:'recovered',turn:{id:'recovered-turn',status:'completed'}});
  });
  assert.equal(await row('recovered').getAttribute('data-error'),'false');
  assert.equal(await row('recovered').getAttribute('class'),'thread-item');
  await page.evaluate(()=>{
    const api=globalThis.__pandaForceDebug;(api.state.active=api.state.threads.find(thread=>thread.id==='running'), api.workbench.threadOpened(api.state.active.id));
    api.notify('turn/started',{threadId:'running',turn:{id:'auto-turn'}});
    api.notify('error',{threadId:'running',turnId:'auto-turn',error:{message:'Selected model is at capacity'}});
    api.notify('error',{threadId:'running',turnId:'auto-turn',error:{message:'Selected model is at capacity'}});
  });
  await page.waitForTimeout(800);
  // Automatic Continue is owned by the PandaForce service now; the browser only
  // renders the failure and must not create a duplicate turn.
  assert.equal(await page.evaluate(()=>window.__activityCalls.filter(call=>call.method==='turn/steer').length),0);
  assert.equal(await page.evaluate(()=>window.__activityCalls.filter(call=>call.method==='thread/queue/add').length),0);
  await page.evaluate(()=>{globalThis.__pandaForceDebug.state.active=globalThis.__pandaForceDebug.state.threads.find(thread=>thread.id==='idle');globalThis.__pandaForceDebug.workbench.threadOpened('idle')});
  await page.locator('#toggleSummaryPanel').click();
  assert.equal(await page.locator('#summarySessionMarker').textContent(),'idle…');
  assert.equal(await page.locator('#summarySessionMarker').getAttribute('title'),'idle');
  assert.equal(await page.locator('#summarySessionModel').textContent(),'gpt-6.1-sol');
  assert.equal(await page.locator('#summarySessionEffort').textContent(),'High');
  assert.equal(await page.locator('#copySummarySessionMarker').isDisabled(),false);
  await page.locator('#summarySessionName').fill('Renamed idle session');
  await page.locator('#saveSummarySessionName').click();
  await page.waitForFunction(()=>globalThis.__pandaForceDebug.state.active?.name==='Renamed idle session');
  assert.equal(await row('idle').locator('.thread-name').textContent(),'Renamed idle session');
  await page.locator('#closeSummaryPanel').click();
  await page.evaluate(()=>{const api=globalThis.__pandaForceDebug,thread=api.state.threads.find(item=>item.id==='idle');thread.lastActivityAt=Date.now()/1000-7200;api.state.active.lastActivityAt=thread.lastActivityAt;api.refreshThreadRowMetadata()});
  await page.evaluate(()=>{globalThis.__pandaForceI18n.setPreference('zh-CN');globalThis.__pandaForceDebug.refreshThreadRowMetadata()});
  assert.equal(await row('idle').locator('time').textContent(),'2小时前');
  assert.equal(await row('unknown').locator('.thread-running').getAttribute('aria-label'),'进行中');
  assert.match(await row('idle').locator('time').getAttribute('title'),/上次活动：2小时前/);
  assert.deepEqual(errors,[]);console.log('Session activity, stale completion, goals, rename, and responsive metadata passed.');
}finally{
  await browser?.close();await runtime.dispose();
}
