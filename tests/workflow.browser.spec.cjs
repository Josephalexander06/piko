const {test,expect,chromium}=require('@playwright/test');
const http=require('node:http');
const net=require('node:net');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const{spawn}=require('node:child_process');
const{once}=require('node:events');
const root=path.resolve(__dirname,'..');
const python=process.env.PIKO_PYTHON_PATH||path.join(root,'apps/local-service/.venv/bin/python');
const key='piko.assistant.session.v1';
const ttl=30*60*1000;
let context,panel,page,worker,service,fixture,model,profile,base,mode,modelRequests,releaseModel;
const fixtureHTML='<!doctype html><title>Workflow fixture</title><form><label>Full name<input id="name" required></label><label>Email address<input id="email" type="email" required></label><label>Department<select id="department"><option value="" disabled selected>Choose…</option><option value="cs">Computer Science</option><option value="ee">Electronics</option></select></label><input type="password" value="PRIVATE" aria-label="Password"><button>Submit</button></form><script>window.events=[];for(const kind of ["input","change","submit"])document.addEventListener(kind,event=>{window.events.push(kind);if(kind==="submit")event.preventDefault()});</script>';
async function listen(server,port=0){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return`http://127.0.0.1:${server.address().port}`;}
async function start(){
  mode='normal';modelRequests=[];
  const probe=net.createServer();await listen(probe,8765);await new Promise(resolve=>probe.close(resolve));
  profile=await fs.mkdtemp(path.join(os.tmpdir(),'piko-workflow-browser-'));
  fixture=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end(fixtureHTML);});base=await listen(fixture);
  model=http.createServer(async(request,response)=>{
    response.setHeader('Content-Type','application/json');
    let input='';for await(const chunk of request)input+=chunk;
    if(request.url==='/api/tags'){response.end(JSON.stringify({models:[{name:'qwen3.5:2b'}]}));return;}
    if(request.url==='/api/show'){response.end(JSON.stringify({model_info:{'general.architecture':'qwen35'}}));return;}
    const prompt=JSON.parse(input),data=JSON.parse(prompt.messages[1].content);modelRequests.push(data);
    const activeMode=mode;
    if(activeMode==='hold')await new Promise(resolve=>{releaseModel=resolve;});
    if(response.destroyed)return;
    if(activeMode==='failure'){response.writeHead(503);response.end('{"error":"PRIVATE diagnostics"}');return;}
    const updates=[];
    for(const field of data.fields){
      let value;
      if(field.label==='Full name'&&/Alex Thomas/.test(data.transcript))value='Alex Thomas';
      if(field.label==='Full name'&&/Maya Chen/.test(data.transcript))value='Maya Chen';
      if(field.type==='email')value=/[a-z]+@example\.test/.exec(data.transcript)?.[0];
      if(field.label==='Organization'&&data.transcript.includes('Synthetic Org'))value='Synthetic Org';
      if(value)updates.push({fieldId:field.fieldId,target:{kind:field.type,value},evidence:{source:'transcript',factId:null,quote:data.transcript}});
    }
    if(activeMode==='unknown'&&updates[0])updates[0].fieldId=`field_${'f'.repeat(32)}`;
    response.end(JSON.stringify({model:'qwen3.5:2b',done:true,message:{role:'assistant',content:JSON.stringify({updates,clarifications:[]})}}));
  });
  const modelURL=await listen(model);
  service=spawn(python,[path.join(root,'tests/fixtures/speech-companion.py')],{cwd:path.join(root,'apps/local-service'),stdio:['ignore','pipe','pipe'],env:{...process.env,PIKO_TEST_REAL_PIPER:'0',OLLAMA_BASE_URL:modelURL,OLLAMA_MODEL:'qwen3.5:2b',PYTHONUNBUFFERED:'1'}});
  const code=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Companion startup timed out')),10000);service.once('error',()=>{clearTimeout(timer);reject(Error('Companion failed'));});service.stderr.on('data',()=>{});service.stdout.on('data',chunk=>{output=(output+chunk).slice(-2048);const match=/Piko pairing code[^\n]*: ([a-f0-9]{16})/.exec(output);if(match){clearTimeout(timer);output='';resolve(match[1]);}});});
  await expect.poll(async()=>{try{return(await fetch('http://127.0.0.1:8765/v1/health')).status;}catch{return 0;}}).toBe(200);
  await launch();await panel.getByText('Local service connection',{exact:true}).click();await panel.getByLabel('Temporary pairing code').fill(code);await panel.getByRole('button',{name:'Pair extension',exact:true}).click();await expect(panel.getByText('Companion paired',{exact:true})).toBeVisible();await inspect();
}
async function launch(){
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,executablePath:process.env.PIKO_CHROMIUM_PATH||undefined,args:['--enable-unsafe-extension-debugging'],ignoreDefaultArgs:['--disable-extensions']});
  const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Extensions.loadUnpacked',{path:path.join(root,'apps/extension/dist')});worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  page=await context.newPage();await page.goto(base);
  panel=await context.newPage();await panel.setViewportSize({width:360,height:800});
  await panel.addInitScript(()=>{window.__forbidden=[];for(const[object,name]of[[window,'fetch'],[XMLHttpRequest.prototype,'open'],[Storage.prototype,'setItem'],[indexedDB,'open']])object[name]=()=>{window.__forbidden.push(name);throw Error('Panel used direct HTTP or persistent storage');};});
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/sidepanel/index.html`);
  await grant();
}
async function grant(){await page.bringToFront();const cdp=await context.browser().newBrowserCDPSession();const{targetInfos}=await cdp.send('Target.getTargets',{filter:[{}]});const target=targetInfos.find(t=>t.type==='tab'&&t.url===page.url());await cdp.send('Extensions.triggerAction',{id:new URL(worker.url()).hostname,targetId:target.targetId});}
async function inspect(){await page.bringToFront();await panel.getByRole('button',{name:/^Inspect (this page|again)$/}).evaluate(button=>button.click());await expect(panel.getByLabel('Edited answer for this form')).toBeVisible();await expect(panel.getByRole('status').filter({hasText:'Live workflow:'})).toContainText('collecting');}
async function answer(text){await panel.getByLabel('Edited answer for this form').fill(text);await page.bringToFront();await panel.getByRole('button',{name:'Interpret edited answer',exact:true}).evaluate(button=>button.click());}
async function select(label){await panel.getByRole('checkbox',{name:`Include ${label}`,exact:true}).check();}
async function review(){await page.bringToFront();await panel.getByRole('button',{name:'Review selected values',exact:true}).evaluate(button=>button.click());await expect(panel.getByRole('region',{name:'Exact batch approval',exact:true})).toBeVisible();}
async function approve(remember=false){const approval=panel.getByRole('region',{name:'Exact batch approval',exact:true});if(remember)await approval.getByRole('checkbox',{name:'Remember selected answers for this session',exact:true}).check();await approval.getByRole('checkbox',{name:'I approve this exact batch and destination.',exact:true}).check();await page.bringToFront();await approval.getByRole('button',{name:'Approve and fill selected fields',exact:true}).evaluate(button=>button.click());await expect(panel.getByRole('region',{name:'Fill outcomes',exact:true})).toContainText('Batch');}
const stored=()=>worker.evaluate(async key=>(await chrome.storage.session.get(key))[key],key);
test.afterEach(async()=>{
  releaseModel?.();releaseModel=undefined;
  try{
    if(panel&&!panel.isClosed())expect(await panel.evaluate(()=>window.__forbidden)).toEqual([]);
    if(page&&!page.isClosed())expect(await page.evaluate(()=>window.events.filter(kind=>kind==='submit'))).toEqual([]);
    if(worker)expect(await worker.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)))).toEqual([]);
  }finally{
    await context?.close();context=undefined;panel=undefined;page=undefined;worker=undefined;
    if(service){const exited=once(service,'exit');service.kill();await exited;service=undefined;}
    if(fixture)await new Promise(resolve=>fixture.close(resolve));fixture=undefined;
    if(model)await new Promise(resolve=>model.close(resolve));model=undefined;
    if(profile){if(path.dirname(profile)!==os.tmpdir()||!path.basename(profile).startsWith('piko-workflow-browser-'))throw Error('Unexpected cleanup path');await fs.rm(profile,{recursive:true,force:true});profile=undefined;}
  }
});
test('multi-turn questions use only edited current text and filling still requires exact approval',async({},info)=>{
  await start();await expect(panel.getByLabel('Current question')).toContainText('Full name');
  await answer('My full name is Alex Thomas.');await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');await expect(panel.getByLabel('Current question')).toContainText('Email address');
  await answer('My email address is alex@example.test.');await expect(panel.getByLabel('Proposed value for Email address · email')).toHaveValue('alex@example.test');await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');
  expect(modelRequests[1].transcript).toBe('My email address is alex@example.test.');expect(modelRequests[1].knownFacts).toEqual([]);expect(Object.keys(modelRequests[1])).toEqual(['transcript','knownFacts','fields']);
  expect(await page.locator('#name').inputValue()).toBe('');expect(await page.locator('#email').inputValue()).toBe('');
  await select('Full name');await select('Email address');await review();expect((await stored()).facts).toEqual([]);await expect(panel.getByRole('button',{name:'Approve and fill selected fields',exact:true})).toBeDisabled();
  await approve();await expect(page.locator('#name')).toHaveValue('Alex Thomas');await expect(page.locator('#email')).toHaveValue('alex@example.test');expect((await stored()).facts).toEqual([]);
  await expect(panel.getByRole('status').filter({hasText:'Live workflow:'})).toContainText('results');await panel.screenshot({path:info.outputPath('conversation-results.png'),fullPage:true});
});
test('remembering is separate opt-in, reuses only unselected eligible drafts, and Clear session removes facts',async()=>{
  await start();await answer('My full name is Alex Thomas and my email address is alex@example.test.');await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');await select('Full name');await review();
  await panel.getByRole('checkbox',{name:'Remember selected answers for this session',exact:true}).check();expect((await stored()).facts).toEqual([]);expect(await page.locator('#name').inputValue()).toBe('');await approve(true);
  expect((await stored()).facts.map(f=>f.key)).toEqual(['full_name']);
  await page.evaluate(()=>{document.querySelector('#name').value='';});await inspect();await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');await expect(panel.getByRole('checkbox',{name:'Include Full name',exact:true})).not.toBeChecked();
  await expect(panel.getByLabel('Current question')).toContainText('Email address');
  await answer('My email address is alex@example.test.');await expect(panel.getByLabel('Proposed value for Email address · email')).toHaveValue('alex@example.test');expect(modelRequests.at(-1).knownFacts).toHaveLength(1);expect(modelRequests.at(-1).knownFacts[0].text).toBe('full name: Alex Thomas');
  await panel.getByRole('button',{name:'Clear session',exact:true}).click();await expect.poll(stored).toBeUndefined();await expect(panel.getByLabel('Edited answer for this form')).toHaveCount(0);expect(await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)))).toEqual(['piko.localService.session.v1']);
});
test('late interpretations cannot override a manual edit or authorize a stale form',async()=>{
  await start();mode='hold';await answer('My full name is Alex Thomas.');await expect.poll(()=>modelRequests.length).toBe(1);await panel.getByLabel('Proposed value for Full name · text').fill('Manual Person');releaseModel();releaseModel=undefined;
  await panel.waitForTimeout(200);await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Manual Person');
  mode='normal';await answer('My full name is Maya Chen.');await expect(panel.getByLabel('Interpretation feedback')).toBeVisible();await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Manual Person');
  await select('Full name');await review();await page.evaluate(()=>{const previous=document.querySelector('#name');previous.replaceWith(previous.cloneNode(true));});await expect(panel.getByText('Scan is stale',{exact:true})).toBeVisible();await expect(panel.getByRole('region',{name:'Exact batch approval',exact:true})).toHaveCount(0);expect(await page.locator('#name').inputValue()).toBe('');
});
test('skipping leaves required answers unresolved and model failure preserves typed/manual recovery',async()=>{
  await start();await panel.getByRole('button',{name:'Skip this question',exact:true}).click();await expect(panel.getByLabel('Current question')).toContainText('Email address');
  mode='unknown';await answer('My full name is Alex Thomas.');await expect(panel.getByRole('alert')).toContainText('unknown field');await expect(panel.getByLabel('Edited answer for this form')).toHaveValue('My full name is Alex Thomas.');
  await panel.getByLabel('Proposed value for Email address · email').fill('alex@example.test');await select('Email address');await review();await approve();await expect(page.locator('#email')).toHaveValue('alex@example.test');await expect(page.locator('#name')).toHaveValue('');await expect(panel.getByText(/1 required fields have not been verified/)).toBeVisible();
});
test('partial native results remember only successful fields, and conditional fields need a new scan',async()=>{
  await start();await page.evaluate(()=>{document.querySelector('#name').addEventListener('change',event=>{event.target.value='';});});await answer('My full name is Alex Thomas and my email address is alex@example.test.');await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');await select('Full name');await select('Email address');await review();await approve(true);await expect(panel.getByRole('region',{name:'Fill outcomes',exact:true})).toContainText('Batch partial');expect((await stored()).facts.map(f=>f.key)).toEqual(['email']);
  await page.evaluate(()=>{const label=document.createElement('label');label.textContent='Organization';const input=document.createElement('input');input.required=true;input.id='organization';label.append(input);document.querySelector('form').append(label);});await expect(panel.getByText('Scan is stale',{exact:true})).toBeVisible();
  await inspect();await expect(panel.getByLabel('Proposed value for Organization · text')).toHaveValue('');await expect(panel.getByRole('region',{name:'Exact batch approval',exact:true})).toHaveCount(0);
});
test('expired stored facts invalidate approval and are removed before interpretation or reuse',async()=>{
  await start();await panel.getByLabel('Proposed value for Full name · text').fill('Alex Thomas');await select('Full name');await review();
  await worker.evaluate(async({key,ttl})=>{const value=(await chrome.storage.session.get(key))[key];const expiresAt=Date.now()-1;await chrome.storage.session.set({[key]:{...value,createdAt:expiresAt-ttl,expiresAt}});},{key,ttl});
  await panel.getByRole('checkbox',{name:'I approve this exact batch and destination.',exact:true}).check();await page.bringToFront();await panel.getByRole('button',{name:'Approve and fill selected fields',exact:true}).evaluate(button=>button.click());await expect(panel.getByRole('alert')).toContainText('scan context');expect(await page.locator('#name').inputValue()).toBe('');expect(await stored()).toBeUndefined();
});
test('facts survive worker suspension but old field registries do not; browser restart clears session storage',async()=>{
  await start();await panel.getByLabel('Proposed value for Full name · text').fill('Alex Thomas');await select('Full name');await review();await approve(true);const old=await stored();
  const cdp=await context.browser().newBrowserCDPSession();await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
  const nextWorker=context.waitForEvent('serviceworker');const snapshot=await panel.evaluate(async()=>chrome.runtime.sendMessage({type:'PIKO_SESSION_STATUS',requestId:`request_${crypto.randomUUID().replace(/-/g,'')}`}));worker=await nextWorker;expect(snapshot.session.sessionId).toBe(old.sessionId);expect(snapshot.session.facts).toHaveLength(1);
  await inspect();await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');
  await context.close();context=undefined;panel=undefined;page=undefined;worker=undefined;await launch();expect(await stored()).toBeUndefined();await expect(panel.getByLabel('Edited answer for this form')).toHaveCount(0);
});
