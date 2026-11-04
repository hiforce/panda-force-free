import {expect,test,afterEach} from 'bun:test';
import {JSDOM} from 'jsdom';
import {readAsyncQuestions,createAsyncQuestionCard,closeEarlierAsyncQuestions} from '../src/client/async-questions.js';
import {parseRollout} from '../src/server/bridge/live-session.js';
const previous=globalThis.document;let dom:JSDOM;
afterEach(()=>{dom?.window.close();globalThis.document=previous;});
test('host function calls survive rollout parsing as interactive questions',()=>{
 const argumentsText=JSON.stringify({questions:[{title:'Choose a test',options:['Options','Custom answer']}]});
 for(const name of ['request_user_input_async','functions.request_user_input_async']){
  const events=[
   {type:'event_msg',payload:{type:'task_started',turn_id:'questions'}},
   {type:'response_item',payload:{type:'function_call',call_id:'question-call',name,arguments:argumentsText}},
   {type:'response_item',payload:{type:'function_call',call_id:'ordinary-call',name:'unrelated_tool',arguments:argumentsText}},
   {type:'event_msg',payload:{type:'task_complete',turn_id:'questions'}}
  ];
  const state=parseRollout(events.map(event=>JSON.stringify(event)).join('\n'));
  expect(state.turn.items).toHaveLength(1);
  expect(state.turn.items[0].id).toBe('question-call');
  expect(readAsyncQuestions(state.turn.items[0])?.[0].question).toBe('Choose a test');
 }
});
test('async tools normalize their own questions without treating ordinary tool output as a request',()=>{
 const item={type:'dynamicToolCall',tool:'functions.request_user_input_async',arguments:JSON.stringify({questions:[{title:'Select a repository',options:['Public','Private']}]})};
 expect(readAsyncQuestions(item)?.[0].options).toEqual([{label:'Public'},{label:'Private'}]);
 for(const bad of [{...item,tool:'other_tool'},{...item,arguments:'{'},{...item,arguments:{questions:[null]}},{...item,arguments:{questions:[{title:'Question',options:{}}]}}])expect(readAsyncQuestions(bad)).toBeNull();
});
test('answer preparation is explicit, failed preparation remains retryable and later chat closes the historical form',async()=>{
 dom=new JSDOM('<body></body>');globalThis.document=dom.window.document;
 const item={id:'async',type:'mcpToolCall',tool:'request_user_input_async',arguments:{questions:[{title:'Where?',options:['Public','Private']}]}};
 let fail=true,prepared='';const card=createAsyncQuestionCard(item,readAsyncQuestions(item),{t:(s:string)=>s,prepareAnswer:async(text:string)=>{if(fail)throw Error('Synthetic failure');prepared=text;}});document.body.append(card);
 const radio=card.querySelector('input')!;radio.checked=true;radio.dispatchEvent(new dom.window.Event('change'));
 const submit=()=>card.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
 submit();await new Promise(r=>setTimeout(r,0));expect(card.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false);expect(card.open).toBe(true);
 fail=false;submit();await new Promise(r=>setTimeout(r,0));expect(prepared).toBe('Where?\nPublic');expect(card.open).toBe(false);expect(card.dataset.status).toBe('prepared');
 closeEarlierAsyncQuestions(document.body,(s:string)=>s);expect(card.dataset.status).toBe('earlier');expect(card.querySelector<HTMLFieldSetElement>('fieldset')!.disabled).toBe(true);expect(card.querySelector<HTMLButtonElement>('[type=submit]')!.hidden).toBe(true);
});
