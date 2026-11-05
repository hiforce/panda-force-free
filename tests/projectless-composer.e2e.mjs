import { createBrowserFixture } from "./browser-runtime.mjs";

import { artifact, launchOptions } from './browser-runtime.mjs';
const runtime=await createBrowserFixture();


const browser=await runtime.launchBrowser(launchOptions());
const page=await browser.newPage({viewport:{width:1018,height:980},colorScheme:'dark'});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto(runtime.base,{waitUntil:'networkidle'});

const selectedProject=await page.evaluate(()=>({
  trigger:document.querySelector('#composerProjectButton')?.textContent?.trim(),
  triggerHidden:document.querySelector('#composerProjectButton')?.hidden,
  sidebar:document.querySelector('#projectName')?.textContent?.trim(),
  heading:document.querySelector('#emptyState h1')?.textContent?.trim(),
}));
await page.click('#composerProjectButton');
await page.waitForSelector('#folderDialog[open]');
await page.screenshot({path:artifact('composer-project-picker.png'),fullPage:false});
const picker=await page.evaluate(()=>({
  projectless:document.querySelector('#projectlessOption')?.textContent?.replace(/\s+/g,' ').trim(),
  title:document.querySelector('#folderDialog .folder-head strong')?.textContent?.trim(),
}));
await page.click('#projectlessOption');
await page.locator('#prompt').fill('@file');
await page.waitForSelector('#composerAutocomplete:not([hidden])');
await page.screenshot({path:artifact('composer-projectless.png'),fullPage:false});
const chooseProjectAction=await page.evaluate(()=>({
  exists:Boolean(document.querySelector('#composerAutocomplete [data-autocomplete-id="choose-project"]')),
  text:document.querySelector('#composerAutocomplete [data-autocomplete-id="choose-project"]')?.textContent?.replace(/\s+/g,' ').trim(),
}));
await page.click('#composerAutocomplete [data-autocomplete-id="choose-project"]');
const projectPickerReopened=await page.locator('#folderDialog').evaluate(dialog=>dialog.open);
await page.locator('#folderDialog .folder-cancel').click();
const projectless=await page.evaluate(()=>({
  heading:document.querySelector('#emptyState h1')?.textContent?.trim(),
  sidebar:document.querySelector('#projectName')?.textContent?.trim(),
  path:document.querySelector('#projectPath')?.textContent?.trim(),
  threadPath:document.querySelector('#threadPath')?.textContent?.trim(),
  trigger:document.querySelector('#composerProjectButton')?.textContent?.replace(/\s+/g,' ').trim(),
  dialogOpen:document.querySelector('#folderDialog')?.open,
  mentionMessage:document.querySelector('#composerAutocomplete')?.textContent?.trim(),
}));
await page.evaluate(()=>{const api=globalThis.__pandaForceDebug;(api.state.active={id:'existing',name:'Existing task',cwd:`${api.state.config.home}/projects/panda-force`,source:'local'}, api.workbench.threadOpened(api.state.active.id));api.renderHeader()});
const existing=await page.evaluate(()=>({triggerHidden:document.querySelector('#composerProjectButton')?.hidden,placeholder:document.querySelector('#prompt')?.placeholder}));
console.log(JSON.stringify({selectedProject,picker,chooseProjectAction,projectPickerReopened,projectless,existing,errors},null,2));
await browser.close();

if(selectedProject.triggerHidden
  ||!selectedProject.trigger?.includes(selectedProject.sidebar)
  ||selectedProject.heading!=='What can I help?'
  ||picker.title!=='Working folder'
  ||!picker.projectless?.includes('None')||!picker.projectless?.includes('No working folder')
  ||projectless.heading!=='What can I help?'
  ||projectless.sidebar!=='Tasks'
  ||projectless.path!=='~'
  ||projectless.threadPath!==''
  ||projectless.trigger!=='No working folder'
  ||projectless.dialogOpen
  ||!chooseProjectAction.exists||!chooseProjectAction.text?.includes('Choose project')
  ||!projectPickerReopened
  ||!existing.triggerHidden
  ||existing.placeholder!=='Ask for follow-up changes'
  ||errors.length)process.exit(1);
