import {expect,test} from "bun:test";
import {JSDOM} from "jsdom";
import {createComposerDrafts} from "../src/client/composer-drafts.js";
test("legacy new-task draft migrates once and stays isolated between projects",()=>{
 const dom=new JSDOM("",{url:"https://fixture.test"}),old=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:dom.window.localStorage});
 try{
  localStorage.setItem("panda-force-composer-drafts",JSON.stringify({__new__:{text:"Unsent before upgrade",mentions:[],attachments:[{name:"01 产品图.png",status:"ready"}]}}));
  let project="alpha",text="";
  const drafts=createComposerDrafts({getActiveThreadId:()=>null,getNewDraftKey:()=>"__new__:"+project,getDraftSnapshot:()=>({text,mentions:[],attachments:[]})});
  expect(drafts.getComposerDraft()?.text).toBe("Unsent before upgrade");expect(drafts.getComposerDraft()?.attachments[0].name).toBe("01 产品图.png");
  project="beta";expect(drafts.getComposerDraft()).toBeUndefined();text="Beta only";drafts.persistComposerDraft();project="alpha";expect(drafts.getComposerDraft()?.text).toBe("Unsent before upgrade");
 }finally{if(old)Object.defineProperty(globalThis,"localStorage",old);else delete globalThis.localStorage;dom.window.close();}
});
test("a completed session cannot clear a different project's new-session draft",()=>{
 const dom=new JSDOM("",{url:"https://fixture.test"}),old=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
 Object.defineProperty(globalThis,"localStorage",{configurable:true,value:dom.window.localStorage});
 try{
  let project="alpha",text="Alpha unsent";
  const drafts=createComposerDrafts({getActiveThreadId:()=>null,getNewDraftKey:()=>"__new__:project:"+project+":/same-folder",getDraftSnapshot:()=>({text,mentions:[],attachments:[]})});
  drafts.persistComposerDraft();project="beta";text="Beta unsent";drafts.persistComposerDraft();
  drafts.clearComposerDraft("native-alpha");
  expect(drafts.getComposerDraft()?.text).toBe("Beta unsent");
  project="alpha";expect(drafts.getComposerDraft()?.text).toBe("Alpha unsent");
 }finally{if(old)Object.defineProperty(globalThis,"localStorage",old);else delete globalThis.localStorage;dom.window.close();}
});
