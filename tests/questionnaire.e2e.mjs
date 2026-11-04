import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {createProjectVisibilityFixture, waitFor} from './project-visibility-fixture.mjs';
const fixture = await createProjectVisibilityFixture();
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const errors=[], checks=[];
try {
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'en'});
 await fixture.signIn(context);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(fixture.base+'/task/old-alpha');
 await page.locator('#workspacePreparation').waitFor({state:'hidden'});
 await page.waitForFunction(()=>globalThis.__pandaForceDebug?.state.active?.id==='old-alpha');
 const request={id:'questionnaire-roundtrip',method:'item/tool/requestUserInput',params:{threadId:'old-alpha',turnId:'question-turn',itemId:'question-item',isBlocking:true,questions:[
  {id:'strategy',header:'Strategy',question:'Which delivery approach should be used?',options:[{label:'Small iterations',description:'Review each completed iteration.'},{label:'All at once',description:'Review everything together.'}],isOther:true},
  {id:'notes',header:'Notes',question:'What should the acceptance review cover?'},
  {id:'private',header:'Private',question:'Provide the isolated test value.',isSecret:true}
 ]}};
 fixture.requestApproval(request);
 await page.locator('.user-input-card').waitFor();
 const form=page.locator('.user-input-card form');
 assert.equal(await form.locator('fieldset').count(),3);
 assert.ok((await form.locator('.user-input-progress').innerText()).includes('0 of 3'));
 await form.locator('[type=submit]').click();
 assert.equal(fixture.calls().some(c=>c.type==='response'&&c.id===request.id),false);
 await form.locator('[data-question-id=strategy] input[value=custom]').check();
 await form.locator('[data-question-id=strategy] textarea').fill('Start with the project workflow');
 await form.locator('[data-question-id=notes] textarea').fill('Mobile approvals and project membership');
 await form.locator('[data-question-id=private] input[type=password]').fill('synthetic-private-value');
 assert.ok((await form.locator('.user-input-progress').innerText()).includes('3 of 3'));
 checks.push('Multiple questions, single-choice lists, permitted custom answers, required fields and masked private input');
 await page.locator('[data-wb=route][data-route=projects]:visible').first().click();
 await page.locator('#pendingApprovalNotice').click();
 const inbox=page.locator('#approvalInboxDialog');
 assert.equal(await inbox.locator('[data-question-id=strategy] textarea').inputValue(),'Start with the project workflow');
 assert.equal(await inbox.locator('[data-question-id=notes] textarea').inputValue(),'Mobile approvals and project membership');
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  assert.equal(await inbox.evaluate(el=>el.scrollWidth>el.clientWidth),false);
  const radio=await inbox.locator('[type=radio]').first().boundingBox(); assert.ok(radio.width<=20&&radio.height<=20);
  assert.ok((await inbox.locator('[type=submit]').boundingBox()).height>=44);
 }
 checks.push('Unsubmitted answers survive session navigation and appear in the global request inbox; 320/390 pixel touch layout');
 await page.evaluate(()=>globalThis.__pandaForceDebug.state.ws?.close());
 await page.waitForFunction(()=>globalThis.__pandaForceDebug.state.transport==='sse');
 await page.route('**/api/codex/respond',route=>route.fulfill({status:503,json:{error:'Synthetic response failure'}}));
 await inbox.locator('[type=submit]').click();
 await inbox.locator('.user-input-error').waitFor();
 assert.equal(await inbox.locator('[type=submit]').isEnabled(),true);
 assert.equal(await inbox.locator('[data-question-id=notes] textarea').inputValue(),'Mobile approvals and project membership');
 await page.unroute('**/api/codex/respond');
 // Capture a screenshot with the secret field removed; no entered secret is archived.
 await inbox.locator('[data-question-id=private] input').fill('');
 await mkdir('.artifacts/product-projects',{recursive:true});
 await page.screenshot({path:'.artifacts/product-projects/questionnaire-mobile.png'});
 await inbox.locator('[data-question-id=private] input').fill('synthetic-private-value');
 await inbox.locator('[type=submit]').click();
 const response=await waitFor(()=>fixture.calls().find(c=>c.type==='response'&&c.id===request.id));
 assert.deepEqual(response.result,{answers:{strategy:{answers:['Start with the project workflow']},notes:{answers:['Mobile approvals and project membership']},private:{answers:['synthetic-private-value']}}});
 await inbox.waitFor({state:'hidden'});
 assert.equal(fixture.calls().filter(c=>c.type==='response'&&c.id===request.id).length,1);
 checks.push('Failed submission keeps answers and permits retry; answers return in the native schema exactly once');
 assert.deepEqual(errors,[]);
 const result={result:'passed',checks,errors};
 await writeFile('.artifacts/product-projects/questionnaire-results.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}finally{await browser.close();await fixture.dispose();}
