import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

test('server and doctor use only OpenRouter credentials for Jev',async()=>{
 const root=await mkdtemp(join(tmpdir(),'creator-lab-connections-'));
 try{
  for(const file of ['server.mjs','lib','scripts'])await cp(new URL(`../${file}`,import.meta.url),join(root,file),{recursive:true});
  for(const config of [
   {local:'',environment:'test-env-key',expected:'test-env-key'},
   {local:'test-local-key',environment:'test-env-key',expected:'test-local-key'},
   {local:'',environment:'',expected:''}
  ]){
   await writeFile(join(root,'.env'),`OPENROUTER_API_KEY=${config.local}\nTYPESAFE_API_KEY=legacy-local-key\nJEV_API_KEY=legacy-local-alias\n`);
   const env={...process.env,PORT:'5190',LAB_DATA_DIR:join(root,'data'),OPENROUTER_API_KEY:config.environment,TYPESAFE_API_KEY:'legacy-env-key',JEV_API_KEY:'legacy-env-alias',APIFY_TOKEN:'',APIFY_API_TOKEN:'',GROQ_API_KEY:'',FIREWORKS_API_KEY:'',TRANSCRIPTION_PROVIDER:'fireworks'};
   const script=`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import {Readable} from 'node:stream';
    let handler;
    http.createServer=callback=>{handler=callback;return {listen(){}};};
    let expectedKey=${JSON.stringify(config.expected)},calls=0;
    global.fetch=async(url,options)=>{
     calls++;
     assert.equal(url,'https://openrouter.ai/api/v1/key');
     assert.equal(options.headers.Authorization,'Bearer '+expectedKey);
     return Response.json({data:{label:'test'}});
    };
    await import(${JSON.stringify(pathToFileURL(join(root,'server.mjs')).href)});
    async function call(url,method='GET',data={},token=''){
     const req=Readable.from(method==='GET'?[]:[Buffer.from(JSON.stringify(data))]);
     Object.assign(req,{url,method,headers:{host:'127.0.0.1:5190','x-lab-token':token}});
     let status,body;
     const res={setHeader(){},writeHead(value){status=value;},end(value){body=JSON.parse(value);}};
     await handler(req,res);
     assert.equal(status,200);
     assert.equal(JSON.stringify(body).includes('test-env-key'),false);
     assert.equal(JSON.stringify(body).includes('test-local-key'),false);
     assert.equal(JSON.stringify(body).includes('test-session-key'),false);
     return body;
    }
    const boot=await call('/api/bootstrap');
    assert.equal(boot.connections.jev.configured,Boolean(expectedKey));
    const initial=await call('/api/connections/check','POST',{},boot.token);
    assert.equal(initial.jev.verified,Boolean(expectedKey));
    assert.equal(calls,expectedKey?1:0);
    await call('/api/connections','POST',{jev:'  test-session-key  '},boot.token);
    expectedKey='test-session-key';
    assert.equal((await call('/api/bootstrap')).connections.jev.verified,false);
    const checked=await call('/api/connections/check','POST',{},boot.token);
    assert.equal(checked.jev.verified,true);
    assert.equal((await call('/api/bootstrap')).connections.jev.verified,true);
   `;
   await exec(process.execPath,['--input-type=module','-e',script],{env,timeout:10000});
   let stdout;
   try{({stdout}=await exec(process.execPath,[join(root,'scripts','doctor.mjs')],{env,timeout:10000}));}
   catch(error){if(error.code!==1)throw error;stdout=error.stdout;}
   assert.ok(stdout.includes(`${config.expected?'OK':'MISSING'} OpenRouter key (Jev)`));
   assert.equal(stdout.includes('test-env-key'),false);
   assert.equal(stdout.includes('test-local-key'),false);
   if(!config.expected)assert.ok(stdout.includes('Add OPENROUTER_API_KEY to .env.'));
  }
 }finally{await rm(root,{recursive:true,force:true});}
});