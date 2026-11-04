import {afterEach, expect, test} from 'bun:test';
import {JSDOM} from 'jsdom';
import {createUserInputCard} from '../src/client/user-input.js';
let dom: JSDOM;
const previous = globalThis.document;
afterEach(()=>{dom?.window.close();globalThis.document=previous;});
test('opaque question IDs cannot select or mutate object prototype properties', async()=>{
 dom=new JSDOM('<body></body>');globalThis.document=dom.window.document;
 const draft={},ids=['__proto__','constructor','toString'];let response:any;
 const card=createUserInputCard({id:'request',params:{questions:ids.map(id=>({id,header:id,question:'Answer '+id}))}},
 {t:(s:string)=>s,respond:async(_id:any,value:any)=>{response=value;},onResolved:()=>{},onError:()=>{},draft});
 document.body.append(card);
 for(const [index,input] of [...card.querySelectorAll('textarea')].entries()){
  input.value='answer-'+index;input.dispatchEvent(new dom.window.Event('input'));
 }
 card.querySelector('form')!.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await Promise.resolve();
 expect(Object.getPrototypeOf(draft)).toBe(Object.prototype);
 for(const [index,id] of ids.entries()){
  expect(Object.hasOwn(draft,id)).toBe(true);expect(response.answers[id].answers).toEqual(['answer-'+index]);
 }
 expect(({} as any).selected).toBeUndefined();
});
