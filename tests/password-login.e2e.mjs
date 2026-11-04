import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {artifact,launchOptions} from './browser-runtime.mjs';
import {localAuthFixture} from './local-auth-fixture.mjs';
const password='correct horse battery staple';
const browser=await chromium.launch(launchOptions());
try{
 for(const [kind,options] of [['managed',{legacyPassword:password}],['environment',{environmentPassword:password}]]){
  const f=await localAuthFixture(options);
  try{
   const context=await browser.newContext({viewport:{width:1280,height:900},locale:'en'});
   await context.addInitScript(()=>{if(window===window.top)localStorage.setItem('codex-webui-locale','en')});
   const page=await context.newPage();await page.goto(f.base);
   await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor();assert.equal(await page.locator('#usernameField').isVisible(),false);
   await page.locator('#passwordInput').fill('wrong password');await page.locator('#passwordLoginButton').click();
   await page.getByRole('alert').filter({hasText:'Incorrect password'}).waitFor();
   await page.locator('#passwordInput').fill(password);await page.locator('#passwordLoginButton').click();
   await page.getByRole('heading',{name:'Complete your administrator account',exact:true}).waitFor();
   assert.equal(await page.locator('#passwordField').isVisible(),false);assert.equal(await page.locator('#app').isVisible(),false);
   await page.screenshot({path:artifact(`administrator-migration-${kind}.png`)});
   await page.locator('#usernameInput').fill('existing-owner');await page.locator('#passwordLoginButton').click();
   await page.locator('#webuiLogout').waitFor({state:'attached'});
   assert.equal((await (await context.request.get(f.base+'/api/auth/status')).json()).identity.username,'existing-owner');
   await context.close();
  }finally{await f.dispose()}
 }
 const f=await localAuthFixture({host:'0.0.0.0'});
 try{
  const password='Abc123';
  const fallback=await browser.newContext({locale:'fr-FR',extraHTTPHeaders:{'x-forwarded-for':'203.0.113.12'}});
  const fallbackPage=await fallback.newPage();await fallbackPage.goto(f.base);
  await fallbackPage.getByRole('heading',{name:'Create your administrator',exact:true}).waitFor();
  assert.equal(await fallbackPage.locator('html').getAttribute('lang'),'en');
  assert.equal(await fallbackPage.locator('#passwordHint').textContent(),'Use at least 6 characters, including uppercase and lowercase letters and a number.');
  assert.equal(await fallbackPage.locator('#passwordHint').isVisible(),true);await fallback.close();
  const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN',extraHTTPHeaders:{'x-forwarded-for':'203.0.113.12'}});
  const page=await context.newPage();await page.goto(f.base);
  await page.getByRole('heading',{name:'创建管理员账号',exact:true}).waitFor();assert.equal(await page.locator('#installationCodeField').isVisible(),true);
  assert.equal(await page.locator('#passwordHint').textContent(),'至少 6 位，须包含大写字母、小写字母和数字。');
  assert.equal(await page.locator('#passwordHint').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:artifact('administrator-remote-setup-mobile.png')});
  await page.locator('#installationCodeInput').fill('wrong-code');await page.locator('#usernameInput').fill('remote-owner');
  await page.locator('#passwordInput').fill('abc123');await page.locator('#passwordConfirmInput').fill('abc123');await page.locator('#passwordLoginButton').click();
  await page.getByRole('alert').filter({hasText:'密码需为 6–256 位，且包含大写字母、小写字母和数字。'}).waitFor();
  await page.locator('#passwordInput').fill(password);await page.locator('#passwordConfirmInput').fill(password);await page.locator('#passwordLoginButton').click();
  await page.getByRole('alert').filter({hasText:'安装码不正确'}).waitFor();
  await page.locator('#installationCodeInput').fill(f.installationCode);await page.locator('#passwordLoginButton').click();
  await page.locator('#webuiLogout').waitFor({state:'attached'});
  assert.equal((await context.request.get(f.base+'/api/config')).status(),200);
  await context.close();
 }finally{await f.dispose()}
 console.log('Legacy migration, six-character setup, localized rules/errors, English fallback and remote claim-code validation passed.');
}finally{await browser.close()}
