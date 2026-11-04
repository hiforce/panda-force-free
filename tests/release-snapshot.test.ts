import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {exportFree} from '../scripts/release/export-free.mjs';
import {prepareUpdate} from '../scripts/release/prepare-update.mjs';
import {git,assertReleasePath,inspectText,verifySnapshot} from '../scripts/release/snapshot-lib.mjs';
const templates=['README.md','README-zh.md','LICENSE','THIRD_PARTY_NOTICES.md','Dockerfile','docker-compose.yml','docker-compose.build.yml','.env.example','.gitignore','.dockerignore'];
function commit(root:string){git(root,['add','.']);git(root,['commit','-qm','Synthetic fixture']);}
function repository(root:string){mkdirSync(root,{recursive:true});git(root,['init','-q']);git(root,['config','user.name','Fixture']);git(root,['config','user.email','fixture@example.invalid']);}
test('filtered exports exclude private state and internal history; three-way updates preserve public edits',()=>{
 const root=mkdtempSync(join(tmpdir(),'panda-snapshot-')),source=join(root,'source'),publicRepo=join(root,'public');
 try{
  repository(source);mkdirSync(join(source,'src'),{recursive:true});mkdirSync(join(source,'release/community'),{recursive:true});
  writeFileSync(join(source,'package.json'),'{"name":"panda-force"}');writeFileSync(join(source,'bun.lock'),'{"name":"panda-force"}');
  for(const name of templates)writeFileSync(join(source,'release/community',name),'Fixture document\n');
  writeFileSync(join(source,'src/example.js'),'export const a = 1;\n\n\n\nexport const b = 1;\n');
  for(const path of ['.codex/state.json','.claude/config.json','docs/design/internal.txt']){mkdirSync(join(source,path,'..'),{recursive:true});writeFileSync(join(source,path),'Private fixture');}
  const approved=['package.json','bun.lock','src/example.js','release/community/public-files.json',
   ...templates.map(name=>'release/community/'+name),...templates];
  writeFileSync(join(source,'release/community/public-files.json'),JSON.stringify(approved));
  writeFileSync(join(source,'src/proprietary.js'),'Private future feature');
  commit(source);const before=join(root,'before');exportFree({source,destination:before});
  const first=verifySnapshot(before);expect(first.files.some(f=>/\.codex|\.claude|docs\/design|proprietary/.test(f.path))).toBe(false);
  expect(readFileSync(join(before,'package.json'),'utf8')).toContain('panda-force-free');
  repository(publicRepo);cpSync(before,publicRepo,{recursive:true});commit(publicRepo);
  writeFileSync(join(publicRepo,'src/example.js'),'export const a = 1;\n\n\n\nexport const b = 2;\n');commit(publicRepo);
  writeFileSync(join(source,'src/example.js'),'export const a = 2;\n\n\n\nexport const b = 1;\n');commit(source);
  const after=join(root,'after');exportFree({source,destination:after});
  const conflictRepo=join(root,'conflict');
  git(root,['clone','-q',publicRepo,conflictRepo]);
  git(conflictRepo,['config','user.name','Fixture']);git(conflictRepo,['config','user.email','fixture@example.invalid']);
  writeFileSync(join(conflictRepo,'src/example.js'),'export const a = 3;\n\n\n\nexport const b = 2;\n');commit(conflictRepo);
  expect(()=>prepareUpdate({base:before,next:after,out:join(root,'conflict.patch'),repo:conflictRepo,apply:true})).toThrow();
  expect(git(conflictRepo,['diff','--name-only','--diff-filter=U'],{encoding:'utf8'})).toContain('src/example.js');
  const result=prepareUpdate({base:before,next:after,out:join(root,'update.patch'),repo:publicRepo,apply:true});
  expect(result.applied).toBe(true);const merged=readFileSync(join(publicRepo,'src/example.js'),'utf8');
  expect(merged).toContain('a = 2');expect(merged).toContain('b = 2');
  expect(git(publicRepo,['rev-list','--count','HEAD'],{encoding:'utf8'}).trim()).toBe('2');
  writeFileSync(join(after,'src/example.js'),'changed');expect(()=>verifySnapshot(after)).toThrow('changed');
  expect(()=>inspectText('src/config.js',Buffer.from(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')))).toThrow('private key');
  for(const path of ['.git/config','.codex/state','.claude/config','src/.agents/private','src/.aws/key','../escape','AGENTS.md'])expect(()=>assertReleasePath(path)).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});
