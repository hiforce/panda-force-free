import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createStoredPassword} from '../src/server/auth/security.js';
import {saveStoredPassword} from '../src/server/auth/password-store.ts';
let built=false;
export async function localAuthFixture(options={}){
 if(!built){const build=Bun.spawnSync(['bun','run','build:client'],{cwd:new URL('..',import.meta.url).pathname,stdout:'ignore',stderr:'pipe'});if(build.exitCode)throw new Error(Buffer.from(build.stderr).toString());built=true}
 const dir=mkdtempSync(join(tmpdir(),'panda-administrator-')),bin=join(dir,'bin');mkdirSync(bin);
 const legacyPath=join(dir,'legacy.json'),adminPath=join(dir,'administrator.json');
 if(options.legacyPassword)saveStoredPassword(legacyPath,createStoredPassword(options.legacyPassword));
 writeFileSync(join(bin,'codex'),`#!${process.execPath}\nimport {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={codexHome:process.env.CODEX_HOME};if(['model/list','permissionProfile/list','thread/list','thread/loaded/list','thread/queue/list'].includes(m.method))result={data:[]};if(m.method==='account/read')result={account:null};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});\n`,{mode:0o700});
 const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('IDAAS_')));
 Object.assign(env,{PATH:bin+':'+env.PATH,HOME:dir,CODEX_HOME:dir,HOST:options.host||'127.0.0.1',PORT:String(port),NODE_ENV:'production',PANDA_FORCE_PROJECTLESS:'false',PANDA_FORCE_CWD:dir,PANDA_FORCE_REVIEW_ROOT:dir,PANDA_FORCE_APP_SERVER_MODE:'isolated',PANDA_FORCE_ATTACHMENT_STORAGE:'local',PANDA_FORCE_AUTH_MODE:options.authMode||'',PANDA_FORCE_PASSWORD:options.environmentPassword||'',PANDA_FORCE_ACCESS_TOKEN:options.accessToken||'',PANDA_FORCE_AUTH_STORE:legacyPath,PANDA_FORCE_ADMIN_STORE:adminPath});
 let child,logs='',pumps=[];
 const fixture={dir,env,legacyPath,adminPath,base:`http://127.0.0.1:${port}`,
  get installationCode(){return logs.match(/Remote installation code: ([A-Za-z0-9_-]+)/)?.[1]},
  async start(){
   logs='';child=Bun.spawn(options.command||['bun','run','start'],{cwd:new URL('..',import.meta.url).pathname,env,stdout:'pipe',stderr:'pipe'});
   const consume=async stream=>{for await(const chunk of stream)logs=(logs+Buffer.from(chunk).toString()).slice(-20000)};
   pumps=[consume(child.stdout),consume(child.stderr)];
   for(let n=0;n<200;n++){
    if(child.exitCode!==null)throw new Error(`Local auth server exited: ${logs}`);
    try{if((await fetch(fixture.base+'/api/auth/status')).ok)return}catch{}
    await Bun.sleep(25);
   }throw new Error(`Local auth server did not start: ${logs}`);
  },
  async stop(){if(child){child.kill('SIGTERM');await child.exited;await Promise.all(pumps);child=null}},
  async restart(){await fixture.stop();await fixture.start()},
  async dispose(){await fixture.stop();rmSync(dir,{recursive:true,force:true})},
  async post(path,data,headers={}){return fetch(fixture.base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)})},
 };
 try{await fixture.start();return fixture}catch(error){await fixture.dispose();throw error}
}
