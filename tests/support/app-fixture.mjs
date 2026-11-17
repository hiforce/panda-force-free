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
import { seedGoalFixture } from "./goal-fixture.mjs";
import { ProjectCatalog } from "../../src/server/projects/catalog.js";

export async function waitFor(check, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(25);
  }
  throw new Error("Application fixture timed out");
}

export async function createAppFixture({
  freshAdministrator = false,
  initialDatabaseChoice = false,
  historySessions = 0,
  questionnaireRollout = false,
  sharedApprovals = false,
  usageRollout = false,
  nativeInputHistory = false,
  unnamedSessions = false,
  sessionPresentation = /** @type {{titles: string[]; timestamp: number} | null} */ (null),
  models = null,
  applicationCreation = false,
  applicationKnowledge = false,
  account = null,
  engineFiles = {},
  goals = [],
  workspaceDirectory = /** @type {string | null} */ (null),
  prepareState = /** @type {(context: {dir: string; stateRoot: string}) => Promise<void>} */ (async () => {}),
  startupTimeoutMs = 20000,
  extraEnvironment = /** @type {(context: {base: string; dir: string}) => NodeJS.ProcessEnv} */ (() => ({})),
} = {}) {
  // Keep the project inside the application's existing folder-browsing boundary.
  const artifacts = new URL("../../.artifacts/", import.meta.url).pathname;
  mkdirSync(artifacts, { recursive: true });
  const dir = mkdtempSync(join(artifacts, "app-fixture-"));
  if (process.env.PANDA_FORCE_TEST_RUN)
    appendFileSync(
      join(process.env.PANDA_FORCE_TEST_RUN, "fixtures.jsonl"),
      JSON.stringify({ owner: process.pid, suite: process.env.PANDA_FORCE_TEST_SUITE, path: dir }) + "\n",
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
  if (Object.keys(engineFiles).length)
    initial[0].turns = [
      {
        id: "engine-image-turn",
        status: "completed",
        items: [{ id: "engine-viewed-image", type: "imageView", imagePaths: Object.keys(engineFiles) }],
      },
    ];
  if (sessionPresentation)
    for (const [index, thread] of initial.entries()) {
      thread.name = sessionPresentation.titles[index] || thread.name;
      thread.createdAt = sessionPresentation.timestamp;
      thread.updatedAt = sessionPresentation.timestamp;
    }
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
  const goalPath = join(dir, "goals_1.sqlite");
  if (goals.length) seedGoalFixture(goalPath, goals);
  const serverRequest = join(dir, "server-request.json");
  writeFileSync(
    join(dir, "codex"),
    `#!${process.execPath}
import { createInterface } from 'node:readline';
import { Database } from 'bun:sqlite';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { appendFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
let count=0;
let account=${JSON.stringify(account)};
const engineFiles=${JSON.stringify(engineFiles)};
const threads=${JSON.stringify(initial)};
const queues=new Map();
const applicationThreads=new Set(), applicationCalls=new Map();
function applicationSave(pending){
 const callId='save-'+pending.run;applicationCalls.set(callId,{...pending,kind:'save'});
 send({id:callId,method:'item/tool/call',params:{threadId:pending.thread,turnId:pending.run,callId,tool:'panda_documents_create',arguments:{title:'Generated handbook',body:{schema:1,format:'richtext',document:{type:'doc',content:[{type:'heading',attrs:{level:2},content:[{type:'text',text:'A useful result'}]},{type:'paragraph',content:[{type:'text',text:pending.choice?.text||'An editable document from an answered task.'}]}]}},...(pending.choice?.projectId?{archiveTo:{projectId:pending.choice.projectId}}:{}),...(pending.choice?.fileDirectory?{fileDirectory:pending.choice.fileDirectory}:{})}}});
}
const knowledgeThreads=new Map(),knowledgeCalls=new Map();
function knowledgeCall(pending,tool,args){
 const id='knowledge-'+(++count);knowledgeCalls.set(id,pending);
 setTimeout(()=>send({id,method:'item/tool/call',params:{threadId:pending.thread,turnId:pending.run,callId:id,tool,arguments:args}}),15);
}
function knowledgeFinish(pending){send({method:'turn/completed',params:{threadId:pending.thread,turn:{id:pending.run,status:'completed'}}});}
const goalDb=${goals.length > 0} ? new Database(${JSON.stringify(goalPath)}) : null;
function goalResult(id){
  const row=goalDb?.query('SELECT * FROM thread_goals WHERE thread_id=?').get(id);
  return row ? {threadId:row.thread_id,objective:row.objective,status:row.status,tokenBudget:row.token_budget,tokensUsed:row.tokens_used,timeUsedSeconds:row.time_used_seconds,createdAt:row.created_at_ms,updatedAt:row.updated_at_ms} : null;
}
let sharedSocket;
const send=value=>sharedSocket?sharedSocket.send(JSON.stringify(value)):process.stdout.write(JSON.stringify(value)+'\\n');
setInterval(()=>{if(existsSync(${JSON.stringify(serverRequest)})){const request=JSON.parse(readFileSync(${JSON.stringify(serverRequest)},'utf8'));unlinkSync(${JSON.stringify(serverRequest)});send(request)}},50).unref();
const handleLine=line=>{
  const m=JSON.parse(line),p=m.params||{};
  if(!m.method&&('result' in m||'error' in m)){
    const knowledge=knowledgeCalls.get(m.id);
    if(knowledge){knowledgeCalls.delete(m.id);
      if(m.result?.success!==true){knowledgeFinish(knowledge);return;}
      let value;try{value=JSON.parse(m.result.contentItems[0].text);}catch{knowledgeFinish(knowledge);return;}
      if(knowledge.stage==='source'){
        knowledge.source=(knowledge.source||'')+value.text;
        if(value.next!==null)knowledgeCall(knowledge,'panda_knowledge_context',{id:knowledge.manifest.sources[0].id,start:value.next});
        else{const source=knowledge.manifest.sources[0];knowledge.stage='draft';knowledgeCall(knowledge,'panda_knowledge_draft',{schema:1,title:'Reviewed storage knowledge',summary:'Saved source guidance for reliable indexing.',claims:[{id:'claim-1',kind:'source',text:knowledge.source.trim(),evidence:[{sourceId:source.id,version:source.version,quote:knowledge.source.slice(0,Math.min(300,knowledge.source.length)),start:0}]}],uncertainties:[]});}
      }else if(knowledge.stage==='review-source'){
        if(value.next!==null)knowledgeCall(knowledge,'panda_knowledge_review_source',{id:knowledge.manifest.sources[knowledge.sourceIndex].id,start:value.next});
        else if(++knowledge.sourceIndex<knowledge.manifest.sources.length)knowledgeCall(knowledge,'panda_knowledge_review_source',{id:knowledge.manifest.sources[knowledge.sourceIndex].id,start:0});
        else{knowledge.stage='review-draft';knowledge.text='';knowledgeCall(knowledge,'panda_knowledge_review_draft',{start:0});}
      }else if(knowledge.stage==='review-draft'){
        knowledge.text+=value.text;
        if(value.next!==null)knowledgeCall(knowledge,'panda_knowledge_review_draft',{start:value.next});
        else{const draft=JSON.parse(knowledge.text);knowledge.stage='review-decision';knowledgeCall(knowledge,'panda_knowledge_review_decision',{schema:1,verdict:'approve',summary:'The complete draft follows its saved source context.',checks:{faithfulness:true,coverage:true,separation:true,clarity:true,contradictions:true},claims:draft.claims.map(claim=>({id:claim.id,supported:true,reason:'The selected saved source supports this claim.'})),issues:[]});}
      }else knowledgeFinish(knowledge);
      return;
    }
    const pending=applicationCalls.get(m.id);
    if(pending){applicationCalls.delete(m.id);
      if(pending.kind==='question'){
        const callId='context-'+pending.run;applicationCalls.set(callId,{...pending,kind:'context'});
        send({id:callId,method:'item/tool/call',params:{threadId:pending.thread,turnId:pending.run,callId,tool:'panda_creation_context',arguments:{}}});
      }else if(pending.kind==='context'&&m.result?.success&&JSON.parse(m.result.contentItems[0].text).materials.length){
        const material=JSON.parse(m.result.contentItems[0].text).materials[0],callId='material-'+pending.run;
        applicationCalls.set(callId,{...pending,kind:'material'});send({id:callId,method:'item/tool/call',params:{threadId:pending.thread,turnId:pending.run,callId,tool:'panda_creation_material_read',arguments:{id:material.id}}});
      }else if(pending.kind==='context'||pending.kind==='material'){
        const choice=existsSync(${JSON.stringify(join(dir, "creation-output-choice.json"))})?JSON.parse(readFileSync(${JSON.stringify(join(dir, "creation-output-choice.json"))},'utf8')):null;
        if(choice?.projectId){const callId='destinations-'+pending.run;applicationCalls.set(callId,{...pending,kind:'destinations',choice});send({id:callId,method:'item/tool/call',params:{threadId:pending.thread,turnId:pending.run,callId,tool:'panda_documents_destinations',arguments:{search:choice.projectId}}});}
        else if(choice?.fileDirectory){const callId='file-directory-'+pending.run;applicationCalls.set(callId,{...pending,kind:'file-directory',choice});send({id:callId,method:'item/tool/call',params:{threadId:pending.thread,turnId:pending.run,callId,tool:'panda_document_file_directory',arguments:{directory:choice.fileDirectory}}});}
        else applicationSave({...pending,choice});
      }else if(pending.kind==='file-directory'){
        if(m.result?.success&&JSON.parse(m.result.contentItems[0].text).directory)applicationSave(pending);
        else send({method:'turn/completed',params:{threadId:pending.thread,turn:{id:pending.run,status:'completed'}}});
      }else if(pending.kind==='destinations'){
        if(m.result?.success&&JSON.parse(m.result.contentItems[0].text).projects.some(project=>project.id===pending.choice.projectId))applicationSave(pending);
        else send({method:'turn/completed',params:{threadId:pending.thread,turn:{id:pending.run,status:'completed'}}});
      }else send({method:'turn/completed',params:{threadId:pending.thread,turn:{id:pending.run,status:'completed'}}});
    }
    appendFileSync(${JSON.stringify(trace)},JSON.stringify({type:'response',...m})+'\\n');return}
  if(!m.method||m.id===undefined)return;
  appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:m.method,params:p})+'\\n');
  if('pandaProjectless' in p)throw new Error('PandaForce metadata leaked into native RPC');
  let result={};
  if(m.method==='fs/getMetadata') result={isFile:typeof engineFiles[p.path]==='string',isDirectory:false,isSymlink:false,createdAtMs:0,modifiedAtMs:1};
  else if(m.method==='fs/readFile') result={dataBase64:engineFiles[p.path]||''};
  else if(m.method==='initialize')result={codexHome:${JSON.stringify(dir)}};
  else if(m.method==='model/list')result={data:${JSON.stringify(models)}||[{id:'gpt-fixture',model:'gpt-fixture',displayName:'GPT Fixture',defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};
  else if(m.method==='account/read')result={account};
  else if(m.method==='account/logout')account=null;
  else if(m.method==='thread/goal/get')result={goal:goalResult(p.threadId)};
  else if(m.method==='thread/goal/clear'&&goalDb){
    goalDb.query('DELETE FROM thread_goals WHERE thread_id=?').run(p.threadId);
    result={goal:null};send({method:'thread/goal/cleared',params:{threadId:p.threadId,turnId:null}});
  }
  else if(m.method==='thread/goal/set'&&goalDb){
    if(p.status==='active'&&existsSync(${JSON.stringify(join(dir, "goal-resume-fail"))})){
      unlinkSync(${JSON.stringify(join(dir, "goal-resume-fail"))});send({id:m.id,error:{message:'Fixture resume failed'}});return;
    }
    const old=goalResult(p.threadId);
    if(!old){send({id:m.id,error:{message:'No goal in fixture'}});return}
    goalDb.query('UPDATE thread_goals SET status=?,objective=?,updated_at_ms=? WHERE thread_id=?').run(p.status??old.status,p.objective??old.objective,Date.now(),p.threadId);
    result={goal:goalResult(p.threadId)};
    send({method:'thread/goal/updated',params:{threadId:p.threadId,turnId:null,goal:result.goal}});
    if(p.status==='active'&&existsSync(${JSON.stringify(join(dir, "goal-resume-wait"))})){
      unlinkSync(${JSON.stringify(join(dir, "goal-resume-wait"))});
      const reply=result;const waiting=setInterval(()=>{if(existsSync(${JSON.stringify(join(dir, "goal-resume-release"))})){clearInterval(waiting);unlinkSync(${JSON.stringify(join(dir, "goal-resume-release"))});send({id:m.id,result:reply})}},20);return;
    }
  }
  else if(m.method==='thread/list'){const offset=Number(p.cursor)||0,limit=p.limit||50;result={data:threads.slice(offset,offset+limit),nextCursor:offset+limit<threads.length?String(offset+limit):null}}
  else if(m.method==='thread/start'){
    if(p.model==='fail'){send({id:m.id,error:{message:'Fixture creation failed'}});return}
    const thread={id:'new-'+(++count),name:${unnamedSessions} ? null : 'New session '+count,preview:'',cwd:p.cwd,status:{type:'idle'},createdAt:Date.now()/1000,updatedAt:Date.now()/1000,turns:[],canAcceptDirectInput:true};
    if(${applicationCreation}&&p.dynamicTools?.some(tool=>tool.name==='panda_documents_create'))applicationThreads.add(thread.id);
    if(${applicationKnowledge}&&p.dynamicTools?.some(tool=>tool.name==='panda_knowledge_draft'))knowledgeThreads.set(thread.id,'draft');
    if(${applicationKnowledge}&&p.dynamicTools?.some(tool=>tool.name==='panda_knowledge_review_decision'))knowledgeThreads.set(thread.id,'review');
    threads.unshift(thread);send({method:'thread/started',params:{thread}});result={thread};
  }else if(m.method==='thread/name/set'){
    const thread=threads.find(t=>t.id===p.threadId);
    if(thread){thread.name=p.name;send({method:'thread/name/updated',params:{threadId:p.threadId,threadName:p.name}})}
  }else if(m.method==='thread/read'||m.method==='thread/resume'){
    const thread=threads.find(t=>t.id===p.threadId);result={thread};
    if(m.method==='thread/resume'){
      send({method:'thread/started',params:{thread}});
      if(${sharedApprovals})send({id:'shared-approval',method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:'shared-approval-turn',itemId:'shared-command',command:'printf approval-check',cwd:${JSON.stringify(alpha)},availableDecisions:['accept','decline','acceptForSession']}});
    }
  }else if(m.method==='turn/start'){
    const thread=threads.find(t=>t.id===p.threadId);
    if(${unnamedSessions}&&thread&&!thread.preview)thread.preview=(p.input||[]).filter(x=>x.type==='text').map(x=>x.text).join('\\n');
    result={turn:{id:'turn-'+(++count),status:applicationThreads.has(p.threadId)||knowledgeThreads.has(p.threadId)?'inProgress':'completed',items:[]}};
    if(${nativeInputHistory}&&thread){
      const item={id:'input-'+result.turn.id,type:'userMessage',content:p.input,clientId:p.clientUserMessageId};
      thread.turns.push({...result.turn,items:[item]});
      send({method:'turn/started',params:{threadId:p.threadId,turn:{...result.turn,status:'inProgress'}}});
      send({method:'item/completed',params:{threadId:p.threadId,turnId:result.turn.id,item}});
      send({method:'turn/completed',params:{threadId:p.threadId,turn:result.turn}});
    }
    if(knowledgeThreads.has(p.threadId)){
      const manifest=JSON.parse(p.input.find(item=>item.type==='text').text),pending={thread:p.threadId,run:result.turn.id,manifest,sourceIndex:0,stage:knowledgeThreads.get(p.threadId)==='review'?'review-source':'source'};
      if(pending.stage==='source'&&manifest.purpose.includes('ask-audience')&&!manifest.dialogue.answers.length){pending.stage='question';knowledgeCall(pending,'panda_knowledge_ask',{questions:[{question:'Who is this knowledge for?',options:['Developers','Writers']}]});}
      else knowledgeCall(pending,pending.stage==='source'?'panda_knowledge_context':'panda_knowledge_review_source',{id:manifest.sources[0].id,start:0});
    }
    if(applicationThreads.has(p.threadId)){
      send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:result.turn.id,itemId:'writing-'+result.turn.id,delta:'I am reviewing the requirements and organizing the document.'}});
      send({method:'thread/tokenUsage/updated',params:{threadId:p.threadId,tokenUsage:{total:{inputTokens:840,outputTokens:160,totalTokens:1000},modelContextWindow:200000}}});
      const run=result.turn.id, id='question-'+run; applicationCalls.set(id,{kind:'question',thread:p.threadId,run});
      setTimeout(()=>send({id,method:'item/tool/requestUserInput',params:{threadId:p.threadId,turnId:run,questions:[{id:'audience',header:'Audience',isOther:true,question:'Who should this document help?',options:[{label:'New users',description:'A short practical introduction.'},{label:'Maintainers',description:'Implementation and operational detail.'}]}]}}),20);
    }
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
    logs: () => serverLogs,
    dir,
    alpha,
    beta,
    base,
    headers,
    /** Seed an existing legacy project without exercising the application's new-project policy. @param {unknown} input */
    legacyProject(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid legacy project fixture");
      const fields = /** @type {Record<string, unknown>} */ (input);
      if (fields.id !== undefined) throw Error("Legacy fixture seeding requires a new catalog identity");
      const catalog = new ProjectCatalog(join(dir, "panda-state/data/projects.sqlite"));
      try {
        return catalog.save(fields, fields.revision ?? catalog.revision());
      } finally {
        catalog.close();
      }
    },
    creationOutput(choice) {
      const path = join(dir, "creation-output-choice.json");
      if (choice) writeFileSync(path, JSON.stringify(choice));
      else if (existsSync(path)) rmSync(path);
    },
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
        headers: { Origin: base },
      });
      if (!response.ok())
        throw new Error(`Fixture login failed: ${response.status()} ${await response.text()}\n${serverLogs}`);
      if ((await response.json()).migrationRequired) {
        const setup = await context.request.post(`${base}/api/auth/setup`, {
          data: { username: "fixture-owner" },
          headers: { Origin: base },
        });
        if (!setup.ok())
          throw new Error(`Fixture migration failed: ${setup.status()} ${await setup.text()}\n${serverLogs}`);
      }
      if (!initialDatabaseChoice) {
        const overview = await context.request.get(`${base}/api/system/database`);
        if (!overview.ok()) throw new Error(`Fixture database overview failed: ${overview.status()}`);
        if ((await overview.json()).initialChoiceRequired) {
          const selection = await context.request.post(`${base}/api/system/database/selection`, {
            data: { driver: "sqlite" },
            headers: { Origin: base },
          });
          if (!selection.ok()) throw new Error(`Fixture database selection failed: ${selection.status()}`);
        }
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
          PANDA_FORCE_PROJECTS_ROOT: join(dir, "panda-state", "projects"),
          PANDA_FORCE_APP_SERVER_MODE: sharedApprovals ? "shared" : "isolated",
          ...(sharedApprovals ? { PANDA_FORCE_APP_SERVER_SOCKET: join(dir, "daemon.sock") } : {}),
          SHELL: "/bin/bash",
          BASH_ENV: "",
          ENV: "",
          NODE_ENV: "production",
          HOME: workspaceDirectory || dir,
          PANDA_FORCE_HOME: join(dir, "panda-state"),
          PANDA_FORCE_AUTH_STORE: join(dir, "panda-state", "config", "password.json"),
          PANDA_FORCE_ADMIN_STORE: join(dir, "panda-state", "config", "administrator.json"),
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
      }, startupTimeoutMs).catch((error) => {
        throw new Error(`${error.message}\n${serverLogs}`);
      });
    },
    processExitCode() {
      return proc?.exitCode ?? null;
    },
    async stop() {
      if (proc) {
        if (proc.exitCode === null) proc.kill();
        const code = await proc.exited;
        proc = null;
        return code;
      }
      return null;
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
    await prepareState({ dir, stateRoot: join(dir, "panda-state") });
    await fixture.start();
    return fixture;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}
