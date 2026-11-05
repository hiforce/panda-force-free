import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createAppFixture,waitFor} from './app-fixture.mjs';
const fixture=await createAppFixture({sharedApprovals:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'en'});
 await fixture.signIn(context);
 await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('panda-force-locale','en')});
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(fixture.base+'/task/old-alpha');
 await page.locator('#workspacePreparation').waitFor({state:'hidden'});
 const card=page.locator('.approval-card');await card.waitFor();
 assert.ok(await card.innerText().then(text=>text.includes('printf approval-check')));
 const resumes=fixture.calls().filter(call=>call.method==='thread/resume');
 assert.equal(resumes.length,1);assert.deepEqual(resumes[0].params,{threadId:'old-alpha',excludeTurns:true});
 assert.equal(fixture.calls().some(call=>call.method==='thread/read'),false);
 await page.reload();await page.locator('#workspacePreparation').waitFor({state:'hidden'});await card.waitFor();
 await page.evaluate(()=>globalThis.__pandaForceDebug.state.ws?.close());
 await page.waitForFunction(()=>globalThis.__pandaForceDebug.state.transport==='sse');
 await card.locator('.approval-primary').click();
 await waitFor(()=>fixture.calls().some(call=>call.type==='response'&&call.id==='shared-approval'));
 assert.deepEqual(fixture.calls().find(call=>call.type==='response'&&call.id==='shared-approval').result,{decision:'accept'});
 assert.equal(fixture.calls().filter(call=>call.type==='response'&&call.id==='shared-approval').length,1);
 await card.waitFor({state:'hidden'});assert.deepEqual(errors,[]);
 console.log(JSON.stringify({largeHistoryUsesNativePages:true,metadataOnlySubscription:true,approvalVisible:true,pendingApprovalSurvivesRefresh:true,sseFallback:true,decisionDeliveredExactlyOnce:true,mobile:true,errors}));
}finally{await browser.close();await fixture.dispose();}
