import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {createProjectVisibilityFixture} from './project-visibility-fixture.mjs';
const fixture=await createProjectVisibilityFixture();const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});await fixture.signIn(context);const page=await context.newPage();await page.goto(fixture.base+'/workspace');await page.locator('#workspacePreparation').waitFor({state:'hidden'});
await page.evaluate(async data=>{const blob=await(await fetch('data:image/png;base64,'+data)).blob();await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);},readFileSync('public/assets/panda-icon.png').toString('base64'));
await page.locator('#prompt').fill('Retain this draft');
await page.locator('#prompt').focus();
await page.locator('#prompt').evaluate(el=>el.setSelectionRange(3,8));
await page.evaluate(()=>{const api=globalThis.__pandaForceDebug;api.state.threads[0].name='Updated by background refresh';api.workbench.refresh();});
await page.waitForTimeout(100);
if(!await page.locator('#prompt').evaluate(el=>document.activeElement===el&&el.selectionStart===3&&el.selectionEnd===8))throw new Error('Background refresh lost focus or selection');
await page.keyboard.press('Control+V');await page.waitForFunction(()=>globalThis.__pandaForceDebug.state.composerAttachments[0]?.status==='ready');console.log(JSON.stringify(await page.evaluate(()=>globalThis.__pandaForceDebug.state.composerAttachments.map(a=>({name:a.name,status:a.status,kind:a.kind})))));
for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Composer layout overflow');}
await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'.artifacts/codex-projects-release/composer-fixed.png'});
}finally{await browser.close();await fixture.dispose()}
