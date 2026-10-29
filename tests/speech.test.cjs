const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const createLoader = require('./helpers/load-typescript.cjs');
const root = path.resolve(__dirname,'../apps/extension/src');
const load = createLoader();
const { isSpeechText, isSpeechWav, isSpeechRequest } = load(path.join(root,'features/voice-output/speech.validation.ts'));
const { SpeechTransfer } = load(path.join(root,'background/speech-transfer.ts'));
const { AudioPlayer } = load(path.join(root,'features/voice-output/audio-player.ts'));
const { VoiceCoordinator, voiceSession } = load(path.join(root,'features/voice-output/voice-session.ts'));
const { SpeechError, SPEECH_CHUNK_BYTES, MAX_SPEECH_BYTES } = load(path.join(root,'features/voice-output/speech.types.ts'));
const { speechPrompt } = load(path.join(root,'features/voice-output/speech-prompts.ts'));
const id = `speech_${'a'.repeat(32)}`;
const flush=()=>new Promise(setImmediate);
function wav(frames=2205) {
  const bytes=new Uint8Array(44+frames*2); const view=new DataView(bytes.buffer);
  const tag=(offset,text)=>[...text].forEach((c,i)=>{bytes[offset+i]=c.charCodeAt(0);});
  tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,22050,true);view.setUint32(28,44100,true);view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,frames*2,true);return bytes;
}
test('speech schemas reject directives, controls, unknown paths and invalid WAV bounds',()=>{
  assert.equal(isSpeechText('What is your full name?'),true);
  for(const text of ['', ' ', 'x'.repeat(801), '<speak>hello</speak>', '[[phonemes]]', '［［phonemes］］', 'Hi\nPRIVATE', 'Hi\u202e', '\ud800'])assert.equal(isSpeechText(text),false);
  assert.equal(isSpeechRequest({type:'synthesize',speechId:id,text:'Hello'}),true);
  assert.equal(isSpeechRequest({type:'synthesize',speechId:id,text:'Hello',path:'PRIVATE'}),false);
  assert.equal(isSpeechWav(wav()),true);
  for(const bytes of [wav().slice(0,-1),new Uint8Array(MAX_SPEECH_BYTES+1),new Uint8Array(60)])assert.equal(isSpeechWav(bytes),false);
  const stereo=wav();new DataView(stereo.buffer).setUint16(22,2,true);assert.equal(isSpeechWav(stereo),false);
});
test('worker uses ordered acknowledged chunks and releases its buffer after completion',async()=>{
  const replies=[];let released=0;const data=wav(50000);
  const transfer=new SpeechTransfer(reply=>replies.push(reply),async()=>data,()=>released++);
  await transfer.receive({type:'synthesize',speechId:id,text:'Hello'});
  assert.equal(replies[0].type,'begin');assert.equal(transfer.retainedBytes,data.length);
  const chunks=[];
  for(let index=0;index<Math.ceil(data.length/SPEECH_CHUNK_BYTES);index++) {
    await transfer.receive({type:'ack',speechId:id,nextIndex:index});
    const reply=replies.at(-1);assert.equal(reply.type,'chunk');assert.equal(reply.index,index);
    chunks.push(Buffer.from(reply.data,'base64'));
  }
  await transfer.receive({type:'ack',speechId:id,nextIndex:chunks.length});
  assert.equal(replies.at(-1).type,'complete');assert.equal(transfer.retainedBytes,0);assert.equal(released,0);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(data));
  await transfer.receive({type:'release',speechId:id});assert.equal(released,1);
});
test('duplicate/reordered ACKs, wrong IDs and concurrent requests fail closed',async()=>{
  for(const invalid of [{type:'ack',speechId:id,nextIndex:2},{type:'ack',speechId:`speech_${'b'.repeat(32)}`,nextIndex:0},{type:'synthesize',speechId:id,text:'Duplicate'}]) {
    const replies=[];const transfer=new SpeechTransfer(reply=>replies.push(reply),async()=>wav(),()=>{});
    await transfer.receive({type:'synthesize',speechId:id,text:'Hello'});await transfer.receive(invalid);
    assert.equal(replies.at(-1).error,'invalid-speech-transfer');assert.equal(transfer.retainedBytes,0);transfer.dispose();
  }
});
test('cancelling pending synthesis aborts transport and late WAV cannot be sent',async()=>{
  let complete,signal;const replies=[];
  const transfer=new SpeechTransfer(reply=>replies.push(reply),(_text,abort)=>{signal=abort;return new Promise(resolve=>complete=resolve);},()=>{});
  const job=transfer.receive({type:'synthesize',speechId:id,text:'Hello'});
  transfer.dispose();assert.equal(signal.aborted,true);complete(wav());await job;assert.deepEqual(replies,[]);
});
function event() {const listeners=new Set();return {addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f),emit:value=>[...listeners].forEach(f=>f(value))};}
test('panel reconstructs the actual worker protocol and keeps only a playback port lease',async()=>{
  const onMessage=event(),onDisconnect=event();let transfer;
  const port={onMessage,onDisconnect,postMessage:message=>queueMicrotask(()=>void transfer.receive(message)),disconnect:()=>transfer.dispose()};
  transfer=new SpeechTransfer(reply=>queueMicrotask(()=>onMessage.emit(reply)),async()=>wav(50000),()=>{},()=>onDisconnect.emit());
  const {requestSpeech}=createLoader({chrome:{runtime:{connect:()=>port}}})(path.join(root,'features/voice-output/speech.service.ts'));
  const result=await requestSpeech('Hello',new AbortController().signal);
  assert.equal(isSpeechWav(result.bytes),true);assert.equal(transfer.retainedBytes,0);
  result.dispose();await result.closed;assert.equal(transfer.retainedBytes,0);
});
test('panel rejects reordered, incomplete, oversized or unsolicited audio replies',async()=>{
  for(const mode of ['reordered','incomplete','oversized','wrong-id','not-wav']) {
    const onMessage=event(),onDisconnect=event();let ended=false;
    const port={onMessage,onDisconnect,disconnect:()=>{ended=true;},postMessage:message=>{
      if(message.type!=='synthesize')return;
      queueMicrotask(()=>{
        const speechId=mode==='wrong-id'?`speech_${'f'.repeat(32)}`:message.speechId;
        onMessage.emit({type:'begin',speechId,mimeType:'audio/wav',byteLength:mode==='oversized'?MAX_SPEECH_BYTES+1:wav().length,chunkCount:1});
        if(mode==='reordered')onMessage.emit({type:'chunk',speechId,index:1,data:Buffer.from(wav()).toString('base64')});
        else if(mode==='not-wav') {onMessage.emit({type:'chunk',speechId,index:0,data:Buffer.from(new Uint8Array(wav().length)).toString('base64')});onMessage.emit({type:'complete',speechId});}
        else onMessage.emit({type:'complete',speechId});
      });
    }};
    const {requestSpeech}=createLoader({chrome:{runtime:{connect:()=>port}}})(path.join(root,'features/voice-output/speech.service.ts'));
    await assert.rejects(requestSpeech('Hello',new AbortController().signal),{code:mode==='not-wav'?'invalid-speech-audio':'invalid-speech-transfer'});assert.equal(ended,true);
  }
});
function playerSetup(play=async()=>{}) {
  const audios=[],created=[],revoked=[];
  const player=new AudioPlayer({createURL:blob=>{assert.equal(blob.type,'audio/wav');const url=`blob:${created.length}`;created.push(url);return url;},revokeURL:url=>revoked.push(url),createAudio:url=>{const audio={url,paused:false,onended:null,onerror:null,play,pause(){this.paused=true;},removeAttribute(){},load(){}};audios.push(audio);return audio;}});
  return {player,audios,created,revoked};
}
test('audio player cancels overlap and revokes every URL on ended, error, rejection and cancellation',async()=>{
  const s=playerSetup();let ended=0,errors=0;
  await s.player.play(wav(),()=>ended++,()=>errors++);s.audios[0].onended();assert.equal(ended,1);assert.equal(s.player.active,false);
  await s.player.play(wav(),()=>{},()=>errors++);s.audios[1].onerror();assert.equal(errors,1);
  await s.player.play(wav(),()=>{},()=>{});await s.player.play(wav(),()=>{},()=>{});assert.equal(s.audios[2].paused,true);s.player.cancel();
  assert.deepEqual(s.created,s.revoked);
  const blocked=playerSetup(async()=>{throw Object.assign(Error('PRIVATE'),{name:'NotAllowedError'});});
  await assert.rejects(blocked.player.play(wav(),()=>{},()=>{}),{code:'speech-playback-blocked'});assert.deepEqual(blocked.created,blocked.revoked);
});
function lease(bytes=wav()) {let close;const value={bytes,disposed:false,closed:new Promise(resolve=>close=resolve),dispose(){this.disposed=true;close();}};return value;}
test('shared owner stops microphone before speech, stops speech before recording, and never overlaps utterances',async()=>{
  const s=playerSetup();let calls=0,stopped=0;const clips=[];
  const owner=new VoiceCoordinator(async()=>{calls++;assert.equal(stopped,1);const clip=lease();clips.push(clip);return clip;},s.player);
  owner.enable();let mic;
  mic=owner.beginRecording(()=>{stopped++;owner.endRecording(mic);});assert.equal(owner.snapshot().recording,true);
  await owner.speak('Question one?');assert.equal(owner.snapshot().recording,false);assert.equal(owner.snapshot().output,'playing');
  await owner.speak('Question two?');assert.equal(clips[0].disposed,true);assert.equal(s.audios[0].paused,true);assert.equal(calls,2);
  const next=owner.beginRecording(()=>{});assert.equal(s.audios[1].paused,true);assert.equal(clips[1].disposed,true);assert.equal(owner.retainedBytes,0);assert.equal(owner.snapshot().recording,true);
  owner.endRecording(next);owner.disable();assert.equal(owner.snapshot().output,'disabled');
});
test('autoplay rejection retains one bounded clip for an explicit synchronous replay and then cleans up',async()=>{
  let blocked=true,calls=0;
  const s=playerSetup(async()=>{if(blocked)throw Object.assign(Error(),{name:'NotAllowedError'});});
  const clip=lease();const owner=new VoiceCoordinator(async()=>{calls++;return clip;},s.player);owner.enable();
  await owner.speak('Visible question?');assert.equal(owner.snapshot().error,'speech-playback-blocked');assert.equal(owner.retainedBytes,wav().length);assert.equal(clip.disposed,false);
  blocked=false;await owner.speak('Visible question?');assert.equal(calls,1);assert.equal(owner.snapshot().output,'playing');
  s.audios.at(-1).onended();assert.equal(owner.retainedBytes,0);assert.equal(clip.disposed,true);assert.deepEqual(s.created,s.revoked);
});
test('disabled speech preserves readable text and stale synthesis cannot start playback',async()=>{
  let complete;const s=playerSetup();const owner=new VoiceCoordinator(()=>new Promise(resolve=>complete=resolve),s.player);
  await owner.speak('Visible while disabled.');assert.equal(owner.snapshot().text,'Visible while disabled.');assert.equal(s.created.length,0);
  owner.enable();const pending=owner.speak('First question?');owner.stopSpeech();const late=lease();complete(late);await pending;
  assert.equal(late.disposed,true);assert.equal(s.created.length,0);owner.reset();
});
test('automatic prompts never interpolate model questions, evidence or arbitrary webpage labels',()=>{
  const fieldId=`field_${'a'.repeat(32)}`;
  const result={updates:[],clarifications:[{question:'PRIVATE name and email [[directive]]',targetFieldIds:[fieldId]}],missingFields:[]};
  assert.equal(speechPrompt(result,[{fieldId,label:'PRIVATE email@example.test'}]),'Please clarify your answer for this field.');
  assert.equal(speechPrompt(result,[{fieldId,label:'Full name'}]),'What is your full name?');
});
test('recording controller participates in the same shared owner instead of independently opening the microphone',async()=>{
  const {RecordingController}=load(path.join(root,'features/voice-input/recording.controller.ts'));
  voiceSession.reset();let stopped=false;
  const track={stop(){stopped=true;},addEventListener(){}};
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const recorder={state:'inactive',mimeType:'audio/webm',start(){this.state='recording';},stop(){this.state='inactive';}};
  const controller=new RecordingController(()=>{},async()=>{throw Error('No upload expected');},{getUserMedia:async()=>stream,createRecorder:()=>recorder,supports:()=>true});
  await controller.start();assert.equal(voiceSession.snapshot().recording,true);controller.reset();assert.equal(stopped,true);assert.equal(voiceSession.snapshot().recording,false);voiceSession.reset();
});
