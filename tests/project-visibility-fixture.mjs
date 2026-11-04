import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

export async function waitFor(check) {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error('Project visibility fixture timed out');
}

export async function createProjectVisibilityFixture({ freshAdministrator = false, historySessions = 0 } = {}) {
  // Keep the project inside the application's existing folder-browsing boundary.
  const artifacts = new URL('../.artifacts/', import.meta.url).pathname;
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(join(artifacts, 'project-visibility-'));
  const alpha = join(dir, 'alpha'), beta = join(dir, 'beta');
  mkdirSync(alpha); mkdirSync(beta);
  const initial = [
    { id: 'old-alpha', name: 'Old alpha session', cwd: alpha, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, turns: [], canAcceptDirectInput: true },
    { id: 'old-beta', name: 'Old beta session', cwd: beta, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, turns: [], canAcceptDirectInput: true },
    { id: 'tasks', name: 'Task without a project', projectless: true, status: { type: 'idle' }, turns: [] },
  ];
  for (let n = 0; n < historySessions; n++) initial.push({ id: 'historic-' + n, name: 'Historical session ' + n, cwd: alpha, status: { type: 'idle' }, createdAt: 1, updatedAt: 1, turns: [] });
  const trace = join(dir, 'native-calls.jsonl');
  const serverRequest = join(dir, 'server-request.json');
  writeFileSync(join(dir, 'codex'), `#!${process.execPath}
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
let count=0;
const threads=${JSON.stringify(initial)};
const queues=new Map();
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
setInterval(()=>{if(existsSync(${JSON.stringify(serverRequest)})){const request=JSON.parse(readFileSync(${JSON.stringify(serverRequest)},'utf8'));unlinkSync(${JSON.stringify(serverRequest)});send(request)}},50).unref();
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params||{};
  if(!m.method&&('result' in m||'error' in m)){appendFileSync(${JSON.stringify(trace)},JSON.stringify({type:'response',...m})+'\\n');return}
  if(!m.method||m.id===undefined)return;
  appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:m.method,params:p})+'\\n');
  if('pandaProjectless' in p)throw new Error('PandaForce metadata leaked into native RPC');
  let result={};
  if(m.method==='initialize')result={codexHome:${JSON.stringify(dir)}};
  else if(m.method==='model/list')result={data:[{id:'gpt-fixture',model:'gpt-fixture',displayName:'GPT Fixture',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
  else if(m.method==='account/read')result={account:null};
  else if(m.method==='thread/list'){const offset=Number(p.cursor)||0,limit=p.limit||50;result={data:threads.slice(offset,offset+limit),nextCursor:offset+limit<threads.length?String(offset+limit):null}}
  else if(m.method==='thread/start'){
    if(p.model==='fail'){send({id:m.id,error:{message:'Fixture creation failed'}});return}
    const thread={id:'new-'+(++count),name:'New session '+count,cwd:p.cwd,status:{type:'idle'},createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[],canAcceptDirectInput:true};
    threads.unshift(thread);send({method:'thread/started',params:{thread}});result={thread};
  }else if(m.method==='thread/read'||m.method==='thread/resume'){
    const thread=threads.find(t=>t.id===p.threadId);result={thread};
    if(m.method==='thread/resume')send({method:'thread/started',params:{thread}});
  }else if(m.method==='turn/start'){
    result={turn:{id:'turn-'+(++count),status:'completed',items:[]}};
    send({method:'thread/status/changed',params:{threadId:p.threadId,status:{type:'idle'}}});
  }else if(m.method==='thread/queue/add'){
    const queuedSubmission={id:'queue-'+(++count),clientUserMessageId:p.clientUserMessageId,input:p.input};
    queues.set(p.threadId,[queuedSubmission]);result={queuedSubmission};
  }else if(m.method==='thread/queue/list')result={data:queues.get(p.threadId)||[]};
  else if(m.method==='thread/turns/list'||m.method==='permissionProfile/list')result={data:[]};
  else if(m.method==='host/thread/live')result={active:false,turn:null};
  send({id:m.id,result});
});
`, { mode: 0o700 });
  const port = await new Promise(resolve => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Basic ${Buffer.from('codex:visibility-test').toString('base64')}` };
  let proc;
  let serverLogs = "";
  const fixture = {
    dir, alpha, beta, base, headers,
    calls() { try { return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
    requestApproval(request) { writeFileSync(serverRequest + '.tmp', JSON.stringify(request)); renameSync(serverRequest + '.tmp', serverRequest); },
    async signIn(context) {
      const response = await context.request.post(`${base}/api/auth/login`, { data: { username: 'fixture-owner', password: 'visibility-test' } });
      if (!response.ok()) throw new Error(`Fixture login failed: ${response.status()}`);
      if ((await response.json()).migrationRequired) {
        const setup = await context.request.post(`${base}/api/auth/setup`, { data: { username: 'fixture-owner' } });
        if (!setup.ok()) throw new Error(`Fixture migration failed: ${setup.status()}`);
      }
    },
    async start() {
      proc = Bun.spawn(['bun', 'run', 'src/server/main.ts'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: { ...process.env, NODE_ENV: 'production', HOME: new URL('..', import.meta.url).pathname, PANDA_FORCE_HOME: join(dir, 'panda-state'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', PATH: `${dir}:${process.env.PATH}`, CODEX_HOME: dir, PANDA_FORCE_CWD: alpha, PANDA_FORCE_PROJECTLESS: 'false', HOST: '127.0.0.1', PORT: String(port), PANDA_FORCE_PASSWORD: '', PANDA_FORCE_ACCESS_TOKEN: freshAdministrator ? '' : 'visibility-test' },
        stdout: 'ignore', stderr: 'pipe',
      });
      serverLogs = "";
      void (async () => { for await (const chunk of proc.stderr) serverLogs = (serverLogs + Buffer.from(chunk).toString()).slice(-12000); })();
      await waitFor(async () => { try {
        if (proc.exitCode !== null) throw new Error(`Fixture server exited: ${serverLogs}`);
        const result = await (await fetch(`${base}${freshAdministrator ? '/health/readiness' : '/api/health'}`, { headers })).json();
        return freshAdministrator ? result.ok : result.codex;
      } catch (error) { if (proc.exitCode !== null) throw error; return false; } }).catch(error => { throw new Error(`${error.message}\n${serverLogs}`); });
    },
    async stop() { if (proc) { proc.kill(); await proc.exited; proc = null; } },
    async dispose() { await fixture.stop(); rmSync(dir, { recursive: true, force: true }); },
    async visibility(body) {
      const response = await fetch(`${base}/api/projects/visibility`, body ? { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    async rpc(method, params = {}) {
      return (await (await fetch(`${base}/api/rpc`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method, params }) })).json());
    },
  };
  try { await fixture.start(); return fixture; }
  catch (error) { await fixture.dispose(); throw error; }
}
