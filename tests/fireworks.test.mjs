import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pipeline} from '../lib/pipeline.mjs';
import {prepareAudio,transcribe,RunPausedError,request} from '../lib/providers.mjs';
// A valid one-second WAV exercises real ffmpeg extraction and duration measurement.
function wav(){const b=Buffer.alloc(44+32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(32000,40);return b;}
const row={id:'fireworks-fixture',ownerUsername:'tester',audioUrl:'https://scontent.cdninstagram.com/broken.m4a',videoUrl:'https://scontent.cdninstagram.com/video.mp4',videoDuration:400};
test('Fireworks uploads extracted audio, falls back from broken audio, then caches Jev results across restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fireworks-test-')),old=global.fetch;let uploads=0,jev=0;const downloads=[];
 global.fetch=async(url,opts)=>{
  url=String(url);
  if(url.includes('cdninstagram.com')){downloads.push(url);return new Response(url.includes('broken')?'invalid media':wav());}
  if(url.includes('audio-turbo.api.fireworks.ai')){uploads++;assert.equal(opts.body.get('model'),'whisper-v3-turbo');assert.equal(opts.body.get('response_format'),'verbose_json');assert.equal(opts.body.get('url'),null);assert.equal(opts.body.get('file').type,'audio/flac');assert.ok(opts.body.get('file').size>0);return Response.json({text:'Pick one task and finish it today.',segments:[{start:0,end:1,text:'Pick one task and finish it today.'}]});}
    if(url==='https://openrouter.ai/api/v1/systemone'){jev++;const req=JSON.parse(opts.body);assert.equal(req.model,'typesafe/jev-1.13');return Response.json({model:req.model,answers:Object.fromEntries(Object.entries(req.questions).map(([k,q])=>[k,{type:q.type,choice:Object.keys(q.criteria)[0],confidence:.9,probabilities:{[Object.keys(q.criteria)[0]]:1}}])),usage:{input_tokens:1000,output_tokens:100}});}
  throw new Error('Unexpected request');
 };
 try{
  const keys=()=>({fireworks:'test',jev:'test'}),options={transcriptionProvider:'fireworks'};
  const p=await new Pipeline(root,keys,options).init();const job=await p.create({creator:'tester',limit:1},[row]);await p.run(job.id);while(p.active.size)await new Promise(r=>setTimeout(r,10));await p.writes.get(job.id);
  assert.equal(job.status,'complete');assert.equal(job.posts[0].transcript.source,'fireworks');assert.equal(job.posts[0].transcript.duration,1);assert.ok(Math.abs(job.posts[0].transcript.costUsd-.0009/60)<1e-12);assert.equal(job.posts[0].transcript.segments[0].end,1);assert.equal(downloads.length,2);assert.deepEqual(await readdir(join(root,'tmp')),[]);
  const restarted=await new Pipeline(root,keys,options).init();const again=await restarted.create({creator:'tester',limit:1},[row]);await restarted.run(again.id);while(restarted.active.size)await new Promise(r=>setTimeout(r,10));await restarted.writes.get(again.id);assert.equal(again.status,'complete');assert.equal(uploads,1);assert.equal(jev,1);assert.equal(again.posts[0].analysis.reused,true);
 }finally{global.fetch=old;await rm(root,{recursive:true,force:true});}
});
test('Fireworks selection never silently uses Groq credentials',async()=>{const root=await mkdtemp(join(tmpdir(),'fireworks-key-'));try{const p=await new Pipeline(root,()=>({groq:'test',jev:'test'}),{transcriptionProvider:'fireworks'}).init();const j=await p.create({creator:'tester'},[row]);await assert.rejects(p.run(j.id),/Connect Fireworks/);assert.equal(j.status,'ready');}finally{await rm(root,{recursive:true,force:true});}});
test('paused Fireworks work sends no audio',async()=>{await assert.rejects(transcribe(row,'test',tmpdir(),{provider:'fireworks',cancelled:()=>true}),RunPausedError);});
test('provider errors redact a reflected Fireworks key',async()=>{const old=global.fetch;global.fetch=async()=>Response.json({error:{message:'Bad secret-test-key'}},{status:401});try{await assert.rejects(request('https://example.com',{headers:{Authorization:'Bearer secret-test-key'}},{retries:0}),e=>!e.message.includes('secret-test-key')&&e.message.includes('[redacted]'));}finally{global.fetch=old;}});

test('verified silent video is excluded without paying for transcription; failed downloads remain retryable',async()=>{
 const {execFileSync}=await import('node:child_process');const {readFile}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'silent-reel-test-'));const old=global.fetch;
 try{
  const fixture=join(root,'silent.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=black:s=16x16:d=0.1','-an',fixture]);const video=await readFile(fixture);
  global.fetch=async url=>{assert.ok(String(url).includes('cdninstagram.com'));return new Response(video);};
  const pipeline=await new Pipeline(root,()=>({fireworks:'test',jev:'test'}),{transcriptionProvider:'fireworks'}).init();
  const job=await pipeline.create({creator:'tester',limit:1},[{...row,audioUrl:''}]);await pipeline.run(job.id);while(pipeline.active.size)await new Promise(r=>setTimeout(r,10));await pipeline.writes.get(job.id);
  assert.equal(job.status,'complete');assert.equal(job.posts[0].status,'no_audio');assert.equal(job.posts[0].analysis,null);assert.match(job.posts[0].excludedReason,/No audio track/);
  global.fetch=async url=>new Response(String(url).includes('broken')?'expired':video,{status:String(url).includes('broken')?403:200});
  await assert.rejects(prepareAudio(row,join(root,'tmp')),e=>e.name!=='NoAudioTrackError'&&e.message.includes('could not be verified'));
 }finally{global.fetch=old;await rm(root,{recursive:true,force:true});}
});
