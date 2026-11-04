import {expect,test} from 'bun:test';
import {createBrowserDispatch} from '../src/server/bridge/browser-dispatch.ts';
import {splitBrowserRpcParams} from '../src/shared/browser-rpc-compat.js';
test('both generations of browser hints are consumed locally; canonical false overrides an old true',()=>{
 const x=splitBrowserRpcParams({threadId:'active',webuiPrepareInput:true,pandaPrepareInput:false,webuiProjectless:true});
 expect(x.params).toEqual({threadId:'active'});expect(x.flags).toEqual({pandaPrepareInput:false,pandaProjectless:true});
});
test('an old open tab takes the shared prepare path without leaking hints to the native engine',async()=>{
 const requests:any[]=[];
 const bridge=createBrowserDispatch({isAllowedMethod:()=>true,request:async(method,params)=>{requests.push({method,params});return {ok:true};},pendingServerRequests:new Map(),sendRaw:()=>{},broadcast:()=>{}});
 bridge.resolve('thread/resume',({params,flags})=>flags.pandaPrepareInput===true?{thread:{id:params.threadId,canAcceptDirectInput:true}}:undefined);
 const response=await bridge.dispatch({type:'rpc',id:1,method:'thread/resume',params:{threadId:'active',excludeTurns:true,webuiPrepareInput:true}});
 expect(response.result.thread.canAcceptDirectInput).toBe(true);expect(requests).toEqual([]);
 await bridge.dispatch({type:'rpc',id:2,method:'thread/start',params:{cwd:'/tmp',webuiProjectless:true,pandaProjectless:false}});
 expect(requests[0].params).toEqual({cwd:'/tmp'});
});
