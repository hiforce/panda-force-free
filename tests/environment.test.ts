import {expect,test} from 'bun:test';
import {pandaEnvironment} from '../src/server/environment.js';
import {resolveAppServerConnection} from '../src/server/bridge/app-server-connection.js';
import {readOssAttachmentConfig} from '../src/server/workspace/oss-attachments.js';
import {passwordStorePath} from '../src/server/auth/password-store.ts';
import {administratorStorePath} from '../src/server/auth/administrator-store.ts';
test('legacy environment aliases remain read-only compatible; explicit PandaForce values win',()=>{
 const source={CODEX_WEBUI_CWD:'/legacy',CODEX_WEBUI_PASSWORD:'legacy',PANDA_FORCE_PASSWORD:'',PANDA_FORCE_CWD:'/current',CODEX_HOME:'/engine'};
 const result=pandaEnvironment(source);expect(result.PANDA_FORCE_CWD).toBe('/current');expect(result.PANDA_FORCE_PASSWORD).toBe('');expect(result.CODEX_HOME).toBe('/engine');expect(source).not.toHaveProperty('PANDA_FORCE_AUTH_MODE');
 expect(pandaEnvironment({CODEX_WEBUI_CWD:'/legacy'}).PANDA_FORCE_CWD).toBe('/legacy');
});
test('standalone configuration readers consistently accept legacy aliases and canonical overrides',()=>{
 expect(resolveAppServerConnection({CODEX_WEBUI_APP_SERVER_MODE:'shared',PANDA_FORCE_APP_SERVER_MODE:'isolated'},'/tmp')).toEqual({mode:'isolated'});
 expect(readOssAttachmentConfig({CODEX_WEBUI_ATTACHMENT_STORAGE:'local'})).toBeNull();
 expect(passwordStorePath({CODEX_WEBUI_AUTH_STORE:'/tmp/previous-auth'})).toBe('/tmp/previous-auth');
 expect(administratorStorePath({CODEX_WEBUI_ADMIN_STORE:'/tmp/previous-admin',PANDA_FORCE_ADMIN_STORE:'/tmp/current-admin'})).toBe('/tmp/current-admin');
});

test('existing application files are reused without moving or replacing them', async()=>{
 const {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {existingApplicationPath}=await import('../src/server/environment.js');
 const root=mkdtempSync(join(tmpdir(),'panda-state-compat-'));
 try{const old=join(root,'codex-webui-admin.json'),current=join(root,'panda-force-admin.json');writeFileSync(old,'existing');
 expect(existingApplicationPath(current)).toBe(old);expect(existsSync(current)).toBe(false);expect(readFileSync(old,'utf8')).toBe('existing');
 writeFileSync(current,'canonical');expect(existingApplicationPath(current)).toBe(current);
 }finally{rmSync(root,{recursive:true,force:true});}
});
