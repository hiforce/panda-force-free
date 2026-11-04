import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {administratorStorePath,createStoredAdministrator,loadStoredAdministrator,saveStoredAdministrator} from '../src/server/auth/administrator-store.js';
import {createStoredPassword,verifyStoredPassword} from '../src/server/auth/security.js';

test('administrator records normalize identity, retain private hashes and cannot overwrite the first owner',()=>{
 const dir=mkdtempSync(join(tmpdir(),'administrator-store-')),path=join(dir,'private','admin.json'),password='test-only administrator password';
 try{
  const record=createStoredAdministrator('  OWNER.Name  ',password);saveStoredAdministrator(path,record);
  expect(loadStoredAdministrator(path)?.username).toBe('owner.name');expect(verifyStoredPassword(password,loadStoredAdministrator(path)!.password)).toBe(true);
  expect(readFileSync(path,'utf8')).not.toContain(password);expect(statSync(path).mode&0o777).toBe(0o600);
  expect(()=>saveStoredAdministrator(path,createStoredAdministrator('other-owner',password))).toThrow();expect(loadStoredAdministrator(path)).toEqual(record);
  expect(()=>createStoredAdministrator('<script>',password)).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('legacy migration preserves the existing credential and corrupt admin files fail closed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'administrator-migration-')),path=join(dir,'admin.json');
 try{
  const password=createStoredPassword('legacy test password');const record=createStoredAdministrator('admin',password);
  expect(record.password).toEqual(password);saveStoredAdministrator(path,record);expect(loadStoredAdministrator(path)).toEqual(record);
  writeFileSync(path,JSON.stringify({...record,role:'guest'}));expect(()=>loadStoredAdministrator(path)).toThrow('Invalid PandaForce administrator store');
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('administrator paths keep custom and test state isolated',()=>{
 expect(administratorStorePath({CODEX_HOME:'/tmp/isolated'})).toBe('/tmp/isolated/codex-webui-admin.json');
 expect(administratorStorePath({CODEX_WEBUI_AUTH_STORE:'/tmp/legacy.json'})).toBe('/tmp/legacy.json.administrator.json');
 expect(administratorStorePath({CODEX_WEBUI_ADMIN_STORE:'/tmp/administrator.json'})).toBe('/tmp/administrator.json');
});
