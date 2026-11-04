import {expect,test} from 'bun:test';
import {existsSync,readFileSync,statSync} from 'node:fs';
import WebSocket from 'ws';
import {localAuthFixture} from './local-auth-fixture.mjs';
const password='Abc123';
const cookie=(response:Response)=>response.headers.get('set-cookie')!.split(';')[0];
async function status(f:any,headers={}){return (await fetch(f.base+'/api/auth/status',{headers})).json()}
function rejectedUpgrade(url:string){return new Promise<number>((resolve,reject)=>{const socket=new WebSocket(url);socket.on('unexpected-response',(_req,response)=>{response.resume();socket.terminate();resolve(response.statusCode!)});socket.on('open',()=>{socket.close();reject(new Error('Unauthenticated WebSocket accepted'))});socket.on('error',()=>{})})}

test('zero-option startup protects the workspace, creates one administrator and preserves it across restart',async()=>{
 const f=await localAuthFixture();
 try{
  expect(await status(f)).toMatchObject({setupRequired:true,authenticated:false,usernameRequired:false,installationCodeRequired:false});
  for(const path of ['/api/config','/api/rpc','/api/events','/app.bundle.js'])expect((await fetch(f.base+path)).status).toBe(401);
  expect(await rejectedUpgrade(f.base.replace('http','ws')+'/ws')).toBe(401);expect(await rejectedUpgrade(f.base.replace('http','ws')+'/terminal')).toBe(401);
  expect((await f.post('/api/auth/setup',{username:'owner',password},{origin:'https://untrusted.example'})).status).toBe(403);
  const results=await Promise.all(['Owner-A','Owner-B'].map(username=>f.post('/api/auth/setup',{username,password})));
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  const accepted=results.find(r=>r.status===200)!,session=cookie(accepted),record=JSON.parse(readFileSync(f.adminPath,'utf8'));
  expect(record.username).toMatch(/^owner-[ab]$/);expect(statSync(f.adminPath).mode&0o777).toBe(0o600);expect(readFileSync(f.adminPath,'utf8')).not.toContain(password);
  expect(await status(f)).toMatchObject({setupRequired:false,usernameRequired:true,authenticated:false});
  expect((await f.post('/api/auth/setup',{username:'replacement',password},{cookie:session})).status).toBe(409);
  expect((await f.post('/api/auth/login',{username:'wrong',password})).status).toBe(401);
  expect((await f.post('/api/auth/login',{username:record.username,password:'wrong password'})).status).toBe(401);
  await f.restart();expect(await status(f)).toMatchObject({setupRequired:false,authenticated:false});
  const login=await f.post('/api/auth/login',{username:record.username.toUpperCase(),password});expect(login.status).toBe(200);
  expect(await status(f,{cookie:cookie(login)})).toMatchObject({authenticated:true,identity:{username:record.username,role:'admin'}});
  expect((await fetch(f.base+'/api/config',{headers:{cookie:cookie(login)}})).status).toBe(200);
  const logout=await f.post('/api/auth/logout',{}, {cookie:cookie(login)});expect(logout.status).toBe(200);expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
 }finally{await f.dispose()}
},20000);

test('remote and proxied installations require the startup claim code without exposing it in status',async()=>{
 const f=await localAuthFixture({host:'0.0.0.0'}),headers={'x-forwarded-for':'203.0.113.5'};
 try{
  const initial=await status(f,headers);expect(initial.installationCodeRequired).toBe(true);
  for(let n=0;n<50&&!f.installationCode;n++)await Bun.sleep(10);
  expect(f.installationCode).toBeTruthy();expect(JSON.stringify(initial)).not.toContain(f.installationCode);
  expect((await f.post('/api/auth/setup',{username:'owner',password},headers)).status).toBe(403);
  expect((await f.post('/api/auth/setup',{username:'owner',password,installationCode:'wrong'},headers)).status).toBe(403);
  expect((await f.post('/api/auth/setup',{username:'owner',password,installationCode:f.installationCode},headers)).status).toBe(200);
  expect((await f.post('/api/auth/setup',{username:'replacement',password,installationCode:f.installationCode},headers)).status).toBe(409);
 }finally{await f.dispose()}
},20000);

test('existing managed passwords, environment passwords and API tokens can migrate without changing their password',async()=>{
 const password='legacy test password';
 for(const options of [{legacyPassword:password},{environmentPassword:password},{accessToken:password}]){
  const f=await localAuthFixture(options);
  try{
   expect(await status(f)).toMatchObject({setupRequired:false,migrationRequired:true,usernameRequired:false});
   expect((await f.post('/api/auth/setup',{username:'owner'})).status).toBe(401);expect(existsSync(f.adminPath)).toBe(false);
   const login=await f.post('/api/auth/login',{password});expect(login.status).toBe(200);expect(await login.json()).toMatchObject({migrationRequired:true});
   const migrated=await f.post('/api/auth/setup',{username:'owner'},{cookie:cookie(login)});expect(migrated.status).toBe(200);
   if(options.legacyPassword)expect(JSON.parse(readFileSync(f.adminPath,'utf8')).password).toEqual(JSON.parse(readFileSync(f.legacyPath,'utf8')));
   if(options.accessToken)expect((await fetch(f.base+'/api/config',{headers:{authorization:`Bearer ${password}`}})).status).toBe(200);
   expect((await f.post('/api/auth/login',{password})).status).toBe(401);
   f.env.PANDA_FORCE_PASSWORD='';f.env.PANDA_FORCE_ACCESS_TOKEN='';await f.restart();
   expect((await f.post('/api/auth/login',{username:'owner',password})).status).toBe(200);
  }finally{await f.dispose()}
 }
},25000);

test('new administrator passwords enforce length and every required character class before creating an account',async()=>{
 const f=await localAuthFixture();
 try{
  for(const invalid of ['', 'Ab12x', 'abcdef', 'ABCDEF', '123456', 'abc123', 'ABC123', 'Abcdef', 'Aa1'+'x'.repeat(254)]){
   const response=await f.post('/api/auth/setup',{username:'owner',password:invalid});
   expect(response.status).toBe(400);
   expect(await response.json()).toEqual({error:'Password must be 6–256 characters and include uppercase and lowercase letters and a number.'});
   expect(existsSync(f.adminPath)).toBe(false);
  }
  expect((await status(f)).setupRequired).toBe(true);
  const maximum='Aa1'+'x'.repeat(253);
  expect((await f.post('/api/auth/setup',{username:'owner',password:maximum})).status).toBe(200);
  expect((await f.post('/api/auth/login',{username:'owner',password:maximum})).status).toBe(200);
 }finally{await f.dispose()}
},15000);

test('explicit localhost no-auth mode stays available for isolated development',async()=>{
 const f=await localAuthFixture({authMode:'none'});
 try{expect(await status(f)).toMatchObject({setupRequired:false,authenticated:true});expect((await fetch(f.base+'/api/config')).status).toBe(200);expect((await f.post('/api/auth/setup',{username:'owner',password})).status).toBe(409)}finally{await f.dispose()}
},15000);

test('repeated incorrect credentials are rate limited without exposing the administrator',async()=>{
 const f=await localAuthFixture();
 try{
  expect((await f.post('/api/auth/setup',{username:'owner',password})).status).toBe(200);
  for(let attempt=0;attempt<20;attempt++)expect((await f.post('/api/auth/login',{username:'unknown-account',password:'wrong password'})).status).toBe(401);
  const limited=await f.post('/api/auth/login',{username:'owner',password});
  expect(limited.status).toBe(429);expect(limited.headers.get('retry-after')).toBe('300');
  expect((await status(f)).authenticated).toBe(false);
 }finally{await f.dispose()}
},15000);
