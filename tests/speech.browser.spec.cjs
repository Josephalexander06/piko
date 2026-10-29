const {test,expect,chromium}=require('@playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
const python=process.env.PIKO_PYTHON_PATH||path.join(root,'apps/local-service/.venv/bin/python');
let context,panel,worker,service,temporary,fixture,form,requests;
test.beforeEach(()=>{requests=[];});
const longMessage='Hello. I am ready to help you prepare your answers. Please review each question carefully. Your answers will remain visible while this message is playing.';
async function portFree(){const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(8765,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));}
async function start({real=false}={}){
  await portFree(); // Never replace a user's listener.
  temporary=await fs.mkdtemp(path.join(os.tmpdir(),'piko-speech-browser-'));
  requests=[];
  service=spawn(python,[path.join(root,'tests/fixtures/speech-companion.py')],{cwd:path.join(root,'apps/local-service'),stdio:['ignore','pipe','pipe'],env:{...process.env,PIKO_TEST_REAL_PIPER:real?'1':'0',PYTHONUNBUFFERED:'1',OLLAMA_MODEL:real?'qwen2.5:14b':'qwen3.5:2b'}});
  const code=await new Promise((resolve,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(Error('Test companion startup timed out')),20000);
    service.once('error',()=>{clearTimeout(timer);reject(Error('Companion launch failed'));});
    service.once('exit',()=>{clearTimeout(timer);reject(Error('Companion exited before startup'));});
    service.stderr.on('data',()=>{});
    service.stdout.on('data',chunk=>{buffer=(buffer+chunk).slice(-2048);const match=/Piko pairing code[^\n]*: ([a-f0-9]{16})/.exec(buffer);if(match){clearTimeout(timer);buffer='';resolve(match[1]);}});
  });
  await expect.poll(async()=>{try{return(await fetch('http://127.0.0.1:8765/v1/health')).status;}catch{return 0;}}).toBe(200);
  context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,executablePath:process.env.PIKO_CHROMIUM_PATH||undefined,args:['--enable-unsafe-extension-debugging','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'],ignoreDefaultArgs:['--disable-extensions']});
  const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Extensions.loadUnpacked',{path:path.join(root,'apps/extension/dist')});
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  context.on('request',request=>{if(/^https?:/.test(request.url()))requests.push({url:request.url(),worker:!!request.serviceWorker()});});
  panel=await context.newPage();await panel.setViewportSize({width:360,height:800});
  await panel.addInitScript(()=>{
    window.__clips=[];window.__urls=[];window.__revoked=[];window.__streams=[];window.__forbidden=[];window.__audioBlocked=false;window.__ended=0;
    const NativeAudio=Audio;
    window.Audio=function(url){const audio=new NativeAudio(url);window.__clips.push(audio);audio.addEventListener('ended',()=>{window.__ended++;});const play=audio.play.bind(audio);audio.play=()=>window.__audioBlocked?Promise.reject(new DOMException('Synthetic autoplay block','NotAllowedError')):play();return audio;};
    const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
    URL.createObjectURL=blob=>{const url=create(blob);window.__urls.push(url);return url;};URL.revokeObjectURL=url=>{window.__revoked.push(url);revoke(url);};
    const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await capture(constraints);window.__streams.push(stream);return stream;};
    for(const [object,name]of[[window,'fetch'],[XMLHttpRequest.prototype,'open'],[Storage.prototype,'setItem'],[indexedDB,'open']])object[name]=()=>{window.__forbidden.push(name);throw Error('Panel bypassed worker or persisted data');};
  });
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/sidepanel/index.html`);
  await panel.getByText('Local service connection',{exact:true}).click();await panel.getByLabel('Temporary pairing code').fill(code);await panel.getByRole('button',{name:'Pair extension',exact:true}).click();
  await expect(panel.getByText('Companion paired',{exact:true})).toBeVisible();
  await expect(panel.getByRole('list',{name:'Local service capabilities'})).toContainText('Speech synthesis: ready');
}
const speech=()=>panel.getByRole('region',{name:'Spoken responses',exact:true});
async function enabled(message='What is your full name?'){
  await panel.getByLabel('Assistant message to speak').fill(message);
  await panel.getByRole('button',{name:'Enable spoken responses and test voice',exact:true}).click();
}
test.afterEach(async()=>{
  try{
    if(panel&&!panel.isClosed()){
      const stop=panel.getByRole('button',{name:'Stop speech',exact:true});if(await stop.isVisible())await stop.click();
      const discard=panel.getByRole('button',{name:'Discard recording',exact:true});if(await discard.isVisible())await discard.click();
      expect(await panel.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')))).toBe(true);
      expect(await panel.evaluate(()=>[...window.__urls].sort())).toEqual(await panel.evaluate(()=>[...window.__revoked].sort()));
      expect(await panel.evaluate(()=>window.__clips.every(a=>a.paused))).toBe(true);
      expect(await panel.evaluate(()=>window.__forbidden)).toEqual([]);
    }
    if(worker){expect(await worker.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)))).toEqual([]);expect(await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).every(key=>['piko.localService.session.v1','piko.assistant.session.v1'].includes(key)))).toBe(true);}
    expect(requests?.every(r=>r.worker&&r.url.startsWith('http://127.0.0.1:8765/v1/')||form&&r.url===form.url())).toBe(true);
  }finally{
    await context?.close();context=undefined;panel=undefined;worker=undefined;form=undefined;
    if(service){const exited=once(service,'exit');service.kill();await exited;service=undefined;}
    if(fixture)await new Promise(resolve=>fixture.close(resolve));fixture=undefined;
    if(temporary){if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('piko-speech-browser-'))throw Error('Unexpected cleanup path');await fs.rm(temporary,{recursive:true,force:true});temporary=undefined;}
  }
});
test('speech defaults off, worker WAV plays with identical visible text, and audio URLs are released',async({},info)=>{
  await start();await expect(speech()).toContainText('Spoken responses disabled');expect(requests.filter(r=>r.url.endsWith('/synthesize'))).toHaveLength(0);
  await enabled();await expect(speech()).toContainText('Speaking');
  await expect(panel.getByLabel('Assistant message to speak')).toHaveValue('What is your full name?');
  await expect(speech()).toContainText('Spoken responses enabled',{timeout:10000});
  expect(await panel.evaluate(()=>window.__ended)).toBe(1);expect(await panel.evaluate(()=>window.__streams.length)).toBe(0);
  for(const width of[280,360,480]){await panel.setViewportSize({width,height:800});expect(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await panel.screenshot({path:info.outputPath('spoken-response-text-fallback.png'),fullPage:true});
});
test('autoplay rejection provides synchronous manual replay of the prepared clip without a second synthesis',async()=>{
  await start();await panel.evaluate(()=>{window.__audioBlocked=true;});await enabled();
  await expect(speech().getByRole('alert')).toContainText('browser blocked autoplay');
  const count=requests.filter(r=>r.url.endsWith('/synthesize')).length;
  await panel.evaluate(()=>{window.__audioBlocked=false;window.__ended=0;});await speech().getByRole('button',{name:'Play aloud',exact:true}).click();
  await expect(speech()).toContainText('Speaking');expect(requests.filter(r=>r.url.endsWith('/synthesize'))).toHaveLength(count);
  await speech().getByRole('button',{name:'Stop speech',exact:true}).click();await expect(speech()).toContainText('Spoken responses enabled');
});
test('recording and playback interrupt through one owner; playing never causes a transcription upload',async()=>{
  await start();await panel.getByRole('button',{name:'Load demo form',exact:true}).click();await panel.getByRole('button',{name:'Start conversation',exact:true}).click();
  await enabled(longMessage);await expect(speech()).toContainText('Speaking');
  await expect(panel.getByRole('button',{name:'Start voice recording',exact:true})).toBeDisabled();
  await panel.getByRole('button',{name:'Stop speech and record',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Stop recording',exact:true})).toBeVisible();
  expect(await panel.evaluate(()=>window.__clips.every(a=>a.paused))).toBe(true);
  await speech().getByRole('button',{name:'Play aloud',exact:true}).click();
  await expect(speech()).toContainText('Speaking');
  expect(await panel.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')))).toBe(true);
  expect(requests.filter(r=>r.url.endsWith('/transcribe'))).toHaveLength(0);
  await speech().getByRole('button',{name:'Stop speech',exact:true}).click();
  await panel.getByRole('button',{name:'Start voice recording',exact:true}).click();await panel.waitForTimeout(400);
  await panel.getByRole('button',{name:'Stop recording',exact:true}).click();
  await expect(panel.getByLabel('Edit your transcript')).toHaveValue('My full name is Alex Thomas.');
  expect(requests.filter(r=>r.url.endsWith('/transcribe'))).toHaveLength(1);
  await panel.getByRole('button',{name:'Reset session',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Enable spoken responses and test voice',exact:true})).toBeVisible();
  expect(await panel.evaluate(()=>window.__clips.every(a=>a.paused))).toBe(true);
});
test('cancel synthesis, failure and disconnect keep the text readable and do not retain audio',async()=>{
  await start();await enabled('Slow synthetic question.');
  await expect(speech()).toContainText('Preparing speech');await speech().getByRole('button',{name:'Stop speech',exact:true}).click();
  await panel.waitForTimeout(2100);expect(await panel.evaluate(()=>window.__clips.length)).toBe(0);
  await panel.getByLabel('Assistant message to speak').fill('Make this fail.');await speech().getByRole('button',{name:'Play aloud',exact:true}).click();
  await expect(speech().getByRole('alert')).toContainText('speech generation failed');await expect(panel.getByLabel('Assistant message to speak')).toHaveValue('Make this fail.');
  await panel.getByLabel('Assistant message to speak').fill(longMessage);await speech().getByRole('button',{name:'Play aloud',exact:true}).click();await expect(speech()).toContainText('Speaking');
  await panel.getByRole('button',{name:'Disconnect service',exact:true}).click();await expect(speech()).toContainText('Voice unavailable');
  await expect.poll(()=>panel.evaluate(()=>window.__clips.every(a=>a.paused))).toBe(true);
  await expect(panel.getByLabel('Assistant message to speak')).toHaveValue(longMessage);
});
test('installed Piper and optional Qwen 2.5 14B support a spoken question, edited answer and safe spoken review status',async()=>{
  test.skip(process.env.PIKO_TEST_REAL_PIPER!=='1','Opt in to the installed voice and local Qwen model');test.setTimeout(120000);
  await start({real:true});
  fixture=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<form><label>Full name<input value="original"></label><button>Submit</button></form><script>window.writes=0;document.addEventListener("input",()=>window.writes++);document.addEventListener("submit",e=>{e.preventDefault();window.writes++})</script>');});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));form=await context.newPage();await form.goto(`http://127.0.0.1:${fixture.address().port}`);
  const cdp=await context.browser().newBrowserCDPSession();const{targetInfos}=await cdp.send('Target.getTargets',{filter:[{}]});const target=targetInfos.find(t=>t.type==='tab'&&t.url===form.url());await cdp.send('Extensions.triggerAction',{id:new URL(worker.url()).hostname,targetId:target.targetId});
  await panel.getByRole('button',{name:'Inspect this page',exact:true}).evaluate(b=>b.click());await expect(panel.getByLabel('Edited answer for this form')).toBeVisible();
  await enabled();await expect(speech()).toContainText('Speaking');await expect(speech()).toContainText('Spoken responses enabled',{timeout:15000});
  await panel.getByRole('button',{name:'Start voice recording',exact:true}).click();await panel.waitForTimeout(400);await panel.getByRole('button',{name:'Stop recording',exact:true}).click();
  await expect(panel.getByLabel('Edit your transcript')).toHaveValue('My full name is Alex Thomas.');await panel.getByLabel('Edit your transcript').fill('My full name is Alex Thomas.');await panel.getByRole('button',{name:'Accept transcript',exact:true}).click();
  await expect(panel.getByLabel('Edited answer for this form')).toHaveValue('My full name is Alex Thomas.');
  await form.bringToFront();await panel.getByRole('button',{name:'Interpret edited answer',exact:true}).evaluate(b=>b.click());
  await expect(panel.getByLabel('Interpretation feedback')).toContainText('1 validated proposals',{timeout:70000});
  await expect(panel.getByLabel('Assistant message to speak')).toHaveValue('Your answers are ready for review.');
  await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');await expect(panel.getByRole('checkbox',{name:'Include Full name',exact:true})).not.toBeChecked();
  await expect(speech()).toContainText('Spoken responses enabled',{timeout:15000});
  expect(await panel.evaluate(()=>window.__clips.length)).toBeGreaterThanOrEqual(2);
  await expect(form.getByLabel('Full name')).toHaveValue('original');expect(await form.evaluate(()=>window.writes)).toBe(0);
});
