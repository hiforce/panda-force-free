import {
  mkdtempSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  openSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";

export async function waitFor(check) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error("Application fixture timed out");
}

export async function createAppFixture({
  freshAdministrator = false,
  historySessions = 0,
  questionnaireRollout = false,
  sharedApprovals = false,
  usageRollout = false,
  models = null,
  account = null,
  workspaceDirectory = null,
  extraEnvironment = /** @type {(context: {base: string; dir: string}) => NodeJS.ProcessEnv} */ (() => ({})),
} = {}) {
  // Keep the project inside the application's existing folder-browsing boundary.
  const artifacts = new URL("../../.artifacts/", import.meta.url).pathname;
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(join(artifacts, "app-fixture-"));
  if (process.env.PANDA_FORCE_TEST_RUN)
    appendFileSync(
      join(process.env.PANDA_FORCE_TEST_RUN, "fixtures.jsonl"),
      JSON.stringify({ owner: process.pid, path: dir }) + "\n",
    );
  const alpha = join(dir, "alpha"),
    beta = join(dir, "beta");
  mkdirSync(alpha);
  mkdirSync(beta);
  writeFileSync(join(alpha, "package.json"), JSON.stringify({ name: "fixture-workspace", version: "1.0.0" }));
  mkdirSync(join(alpha, "src"));
  writeFileSync(join(alpha, "src", "index.js"), "export const fixture = true;\n");
  writeFileSync(join(alpha, "README.md"), "# Fixture workspace\n");
  const initial = [
    {
      id: "old-alpha",
      name: "Old alpha session",
      cwd: alpha,
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 2,
      turns: [],
      canAcceptDirectInput: true,
    },
    {
      id: "old-beta",
      name: "Old beta session",
      cwd: beta,
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 2,
      turns: [],
      canAcceptDirectInput: true,
    },
    { id: "tasks", name: "Task without a project", projectless: true, status: { type: "idle" }, turns: [] },
  ];
  if (usageRollout) {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions);
    const path = join(sessions, "usage.jsonl");
    initial[0].path = path;
    writeFileSync(
      path,
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 14000,
              input_tokens: 12000,
              output_tokens: 2000,
              cached_input_tokens: 5000,
            },
            last_token_usage: { total_tokens: 4000, input_tokens: 3500, output_tokens: 500 },
            model_context_window: 200000,
          },
        },
      }) + "\n",
    );
  }
  if (sharedApprovals) {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions);
    const path = join(sessions, "large-approval.jsonl");
    const fd = openSync(path, "w");
    ftruncateSync(fd, 9 * 1024 * 1024);
    closeSync(fd);
    initial[0].path = path;
    initial[0].turns = [
      {
        id: "shared-approval-turn",
        status: "inProgress",
        items: [{ id: "approval-context", type: "agentMessage", text: "Waiting for command approval." }],
      },
    ];
  }
  if (questionnaireRollout) {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions);
    const path = join(sessions, "questionnaire.jsonl");
    const turn = {
      id: "questions",
      status: "completed",
      items: [
        { id: "question-user", type: "userMessage", content: [{ type: "text", text: "Show a questionnaire." }] },
        { id: "question-reply", type: "agentMessage", text: "Choose an answer in the question card." },
      ],
    };
    initial[0].path = path;
    initial[0].turns = [turn];
    writeFileSync(
      path,
      [
        { type: "event_msg", payload: { type: "task_started", turn_id: turn.id } },
        {
          type: "response_item",
          payload: {
            id: "async-question-1",
            type: "function_call",
            name: "request_user_input_async",
            arguments: JSON.stringify({
              questions: [
                { title: "Which repository?", options: ["Public free repository", "Private source repository"] },
                { title: "What should change?" },
              ],
            }),
          },
        },
        { type: "event_msg", payload: { type: "task_complete", turn_id: turn.id } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );
  }
  for (let n = 0; n < historySessions; n++)
    initial.push({
      id: "historic-" + n,
      name: "Historical session " + n,
      cwd: alpha,
      status: { type: "idle" },
      createdAt: 1,
      updatedAt: 1,
      turns: [],
    });
  const trace = join(dir, "native-calls.jsonl");
  const serverRequest = join(dir, "server-request.json");
  writeFileSync(
    join(dir, "codex"),
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
let count=0;
let account=${JSON.stringify(account)};
const threads=${JSON.stringify(initial)};
const queues=new Map();
let sharedSocket;
const send=value=>sharedSocket?sharedSocket.send(JSON.stringify(value)):process.stdout.write(JSON.stringify(value)+'\\n');
setInterval(()=>{if(existsSync(${JSON.stringify(serverRequest)})){const request=JSON.parse(readFileSync(${JSON.stringify(serverRequest)},'utf8'));unlinkSync(${JSON.stringify(serverRequest)});send(request)}},50).unref();
const handleLine=line=>{
  const m=JSON.parse(line),p=m.params||{};
  if(!m.method&&('result' in m||'error' in m)){appendFileSync(${JSON.stringify(trace)},JSON.stringify({type:'response',...m})+'\\n');return}
  if(!m.method||m.id===undefined)return;
  appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:m.method,params:p})+'\\n');
  if('pandaProjectless' in p)throw new Error('PandaForce metadata leaked into native RPC');
  let result={};
  if(m.method==='initialize')result={codexHome:${JSON.stringify(dir)}};
  else if(m.method==='model/list')result={data:${JSON.stringify(models)}||[{id:'gpt-fixture',model:'gpt-fixture',displayName:'GPT Fixture',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
  else if(m.method==='account/read')result={account};
  else if(m.method==='account/logout')account=null;
  else if(m.method==='thread/list'){const offset=Number(p.cursor)||0,limit=p.limit||50;result={data:threads.slice(offset,offset+limit),nextCursor:offset+limit<threads.length?String(offset+limit):null}}
  else if(m.method==='thread/start'){
    if(p.model==='fail'){send({id:m.id,error:{message:'Fixture creation failed'}});return}
    const thread={id:'new-'+(++count),name:'New session '+count,cwd:p.cwd,status:{type:'idle'},createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[],canAcceptDirectInput:true};
    threads.unshift(thread);send({method:'thread/started',params:{thread}});result={thread};
  }else if(m.method==='thread/read'||m.method==='thread/resume'){
    const thread=threads.find(t=>t.id===p.threadId);result={thread};
    if(m.method==='thread/resume'){
      send({method:'thread/started',params:{thread}});
      if(${sharedApprovals})send({id:'shared-approval',method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:'shared-approval-turn',itemId:'shared-command',command:'printf approval-check',cwd:${JSON.stringify(alpha)},availableDecisions:['accept','decline','acceptForSession']}});
    }
  }else if(m.method==='turn/start'){
    result={turn:{id:'turn-'+(++count),status:'completed',items:[]}};
    send({method:'thread/status/changed',params:{threadId:p.threadId,status:{type:'idle'}}});
  }else if(m.method==='thread/queue/add'){
    const queuedSubmission={id:'queue-'+(++count),clientUserMessageId:p.clientUserMessageId,input:p.input};
    queues.set(p.threadId,[queuedSubmission]);result={queuedSubmission};
  }else if(m.method==='thread/delete'){
    const index=threads.findIndex(thread=>thread.id===p.threadId);if(index>=0)threads.splice(index,1);
  }else if(m.method==='thread/queue/list')result={data:queues.get(p.threadId)||[]};
  else if(m.method==='thread/turns/list')result={data:threads.find(thread=>thread.id===p.threadId)?.turns||[]};
  else if(m.method==='thread/items/list'){const records=(threads.find(thread=>thread.id===p.threadId)?.turns||[]).flatMap(turn=>turn.items.map(item=>({turnId:turn.id,item}))).reverse();const cursor=Number(p.cursor)||0;result={data:records.slice(cursor,cursor+1),nextCursor:cursor+1<records.length?String(cursor+1):null}}
  else if(m.method==='permissionProfile/list')result={data:[]};
  else if(m.method==='host/thread/live')result={active:false,turn:null};
  send({id:m.id,result});
};
if(${sharedApprovals}){const server=createServer();const wss=new WebSocketServer({server});wss.on('connection',socket=>{sharedSocket=socket;socket.on('message',raw=>handleLine(String(raw)))});server.listen(${JSON.stringify(join(dir, "daemon.sock"))});}
else createInterface({input:process.stdin}).on('line',handleLine);
`,
    { mode: 0o700 },
  );
  const port = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Basic ${Buffer.from("codex:visibility-test").toString("base64")}` };
  let proc,
    daemon,
    disposed = false;
  const shutdown = () => {
    void fixture.dispose().finally(() => process.exit(143));
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
  let serverLogs = "";
  const fixture = {
    dir,
    alpha,
    beta,
    base,
    headers,
    calls() {
      try {
        return readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    requestApproval(request) {
      writeFileSync(serverRequest + ".tmp", JSON.stringify(request));
      renameSync(serverRequest + ".tmp", serverRequest);
    },
    async signIn(context) {
      await context.addInitScript(() => {
        globalThis.__pandaForceTest = true;
      });
      const response = await context.request.post(`${base}/api/auth/login`, {
        data: { username: "fixture-owner", password: "visibility-test" },
      });
      if (!response.ok())
        throw new Error(`Fixture login failed: ${response.status()} ${await response.text()}\n${serverLogs}`);
      if ((await response.json()).migrationRequired) {
        const setup = await context.request.post(`${base}/api/auth/setup`, { data: { username: "fixture-owner" } });
        if (!setup.ok())
          throw new Error(`Fixture migration failed: ${setup.status()} ${await setup.text()}\n${serverLogs}`);
      }
    },
    async start() {
      if (sharedApprovals && !daemon) {
        daemon = Bun.spawn([join(dir, "codex")], { cwd: dir, stdout: "ignore", stderr: "pipe" });
        await waitFor(() => existsSync(join(dir, "daemon.sock")));
      }
      proc = Bun.spawn(["bun", "run", "src/server/main.ts"], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !/^(?:PANDA_FORCE_|CODEX_WEBUI_|IDAAS_|OSS_|ALIYUN_)/.test(key),
            ),
          ),
          PANDA_FORCE_ATTACHMENT_STORAGE: "local",
          PANDA_FORCE_ATTACHMENT_ROOT: join(dir, "panda-state", "attachments"),
          PANDA_FORCE_APP_SERVER_MODE: sharedApprovals ? "shared" : "isolated",
          ...(sharedApprovals ? { PANDA_FORCE_APP_SERVER_SOCKET: join(dir, "daemon.sock") } : {}),
          SHELL: "/bin/bash",
          BASH_ENV: "",
          ENV: "",
          NODE_ENV: "production",
          HOME: workspaceDirectory || dir,
          PANDA_FORCE_HOME: join(dir, "panda-state"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          PATH: `${dir}:${process.env.PATH}`,
          CODEX_HOME: dir,
          PANDA_FORCE_CWD: workspaceDirectory || alpha,
          PANDA_FORCE_PROJECTLESS: "false",
          HOST: "127.0.0.1",
          PORT: String(port),
          PANDA_FORCE_PASSWORD: "",
          PANDA_FORCE_ACCESS_TOKEN: freshAdministrator ? "" : "visibility-test",
          ...extraEnvironment({ base, dir }),
        },
        stdout: "ignore",
        stderr: "pipe",
      });
      serverLogs = "";
      void (async () => {
        for await (const chunk of proc.stderr) serverLogs = (serverLogs + Buffer.from(chunk).toString()).slice(-12000);
      })();
      await waitFor(async () => {
        try {
          if (proc.exitCode !== null) throw new Error(`Fixture server exited: ${serverLogs}`);
          const result = await (
            await fetch(
              `${base}${freshAdministrator || extraEnvironment({ base, dir }).PANDA_FORCE_CLUSTER_ROLE ? "/health/readiness" : "/api/health"}`,
              { headers },
            )
          ).json();
          return freshAdministrator || extraEnvironment({ base, dir }).PANDA_FORCE_CLUSTER_ROLE
            ? result.ok
            : result.codex;
        } catch (error) {
          if (proc.exitCode !== null) throw error;
          return false;
        }
      }).catch((error) => {
        throw new Error(`${error.message}\n${serverLogs}`);
      });
    },
    async stop() {
      if (proc) {
        proc.kill();
        await proc.exited;
        proc = null;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, shutdown);
      await fixture.stop();
      if (daemon) {
        daemon.kill();
        await daemon.exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
    async visibility(body) {
      const response = await fetch(
        `${base}/api/projects/visibility`,
        body
          ? { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }
          : { headers },
      );
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    async rpc(method, params = {}) {
      return await (
        await fetch(`${base}/api/rpc`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: 1, method, params }),
        })
      ).json();
    },
  };
  try {
    await fixture.start();
    return fixture;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}
