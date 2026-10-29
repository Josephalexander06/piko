const { test, expect, chromium } = require('@playwright/test');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
let context, page, panel, worker, service, fixture, ollama, requests, mode, modelCalls, body;
const root = path.resolve(__dirname,'..');
const directory = path.join(root,'apps/local-service');
const python = process.env.PIKO_PYTHON_PATH || path.join(directory,'.venv/bin/python');
const base = 'http://127.0.0.1:8765';
async function listen(server, port=0) { await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return `http://127.0.0.1:${server.address().port}`; }
async function freePort() { const server=net.createServer(); await listen(server,8765);await new Promise(resolve=>server.close(resolve)); }
async function start(real=false) {
  mode='ok'; modelCalls=[]; requests=[];
  fixture=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic interpretation form</title><form><label>Full name<input name="name" value="original name"></label><label>Email address<input name="email" type="email" value="original@example.test"></label><label>Department<select required><option disabled value="">Choose…</option><option value="cs">Computer Science</option><option value="ee">Electronics</option></select></label><input type="password" aria-label="Private password" value="PRIVATE"><input type="hidden" value="HIDDEN"><button>Submit</button></form><script>window.events=[];for(const kind of ["input","change","submit"])document.addEventListener(kind,event=>{window.events.push(kind);if(kind==="submit")event.preventDefault()})</script>');});
  const fixtureURL=await listen(fixture);
  ollama=http.createServer(async(req,res)=>{
    let input=''; for await(const chunk of req) input+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/tags') {res.end(JSON.stringify({models:[{name:'qwen3.5:2b'}]}));return;}
    if(req.url==='/api/show') {res.end(JSON.stringify({model_info:{'general.architecture':'qwen35'}}));return;}
    body=JSON.parse(input); modelCalls.push(body);
    const data=JSON.parse(body.messages[1].content);
    if(mode==='timeout') {await new Promise(resolve=>setTimeout(resolve,1200)); if(res.destroyed)return;}
    const name=data.fields.find(f=>f.label==='Full name');
    const email=data.fields.find(f=>f.type==='email');
    const choice=data.fields.find(f=>f.type==='select');
    const updates=[{fieldId:name.fieldId,target:{kind:'text',value:'Alex Thomas'},evidence:{source:'transcript',factId:null,quote:'My full name is Alex Thomas.'}},{fieldId:email.fieldId,target:{kind:'email',value:'alex@example.test'},evidence:{source:'transcript',factId:null,quote:'My email address is alex@example.test.'}}];
    if(mode==='unknown')updates[0].fieldId=`field_${'f'.repeat(32)}`;
    if(mode==='option')updates.push({fieldId:choice.fieldId,target:{kind:'select',optionId:`option_${'f'.repeat(32)}`},evidence:{source:'transcript',factId:null,quote:data.transcript}});
    res.end(JSON.stringify({model:'qwen3.5:2b',done:true,message:{role:'assistant',content:JSON.stringify({updates,clarifications:[]})}}));
  });
  const modelURL=await listen(ollama);
  await freePort(); // Never stop an existing user service.
  service=spawn(python,['-m','app'],{cwd:directory,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUNBUFFERED:'1',OLLAMA_BASE_URL:real?'http://127.0.0.1:11434':modelURL,OLLAMA_MODEL:'qwen3.5:2b',OLLAMA_TIMEOUT_SECONDS:'60',OLLAMA_MAX_CONCURRENCY:'1'}});
  const code=await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(Error('Companion startup timed out')),10000);
    service.once('error',()=>{clearTimeout(timer);reject(Error('Companion failed to start'));});
    service.stderr.on('data',()=>{});
    service.stdout.on('data',chunk=>{output=(output+chunk).slice(-2048);const match=/Piko pairing code[^\n]*: ([a-f0-9]{16})/.exec(output);if(match){clearTimeout(timer);output='';resolve(match[1]);}});
  });
  await expect.poll(async()=>{try{return(await fetch(`${base}/v1/health`)).status;}catch{return 0;}}).toBe(200);
  context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,executablePath:process.env.PIKO_CHROMIUM_PATH||undefined,args:['--enable-unsafe-extension-debugging'],ignoreDefaultArgs:['--disable-extensions']});
  const cdp=await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked',{path:path.join(root,'apps/extension/dist')});
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).hostname;
  context.on('request',r=>{if(/^https?:/.test(r.url()))requests.push({url:r.url(),worker:!!r.serviceWorker()});});
  page=await context.newPage();await page.goto(fixtureURL);
  panel=await context.newPage();await panel.setViewportSize({width:360,height:800});
  await panel.addInitScript(()=>{
    window.__violations=[];
    for(const [object,name] of [[window,'fetch'],[XMLHttpRequest.prototype,'open'],[Storage.prototype,'setItem'],[indexedDB,'open']]) object[name]=()=>{window.__violations.push(name);throw Error('Panel bypassed worker or persisted data');};
  });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await panel.getByText('Local service connection',{exact:true}).click();
  await panel.getByLabel('Temporary pairing code').fill(code);await panel.getByRole('button',{name:'Pair extension',exact:true}).click();
  await expect(panel.getByText('Companion paired',{exact:true})).toBeVisible();
  await page.bringToFront();
  const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{}]});
  const native=targetInfos.find(t=>t.type==='tab'&&t.url===page.url());
  await cdp.send('Extensions.triggerAction',{id:extensionId,targetId:native.targetId});
  await panel.getByRole('button',{name:'Inspect this page',exact:true}).evaluate(button=>button.click());
  await expect(panel.getByRole('status').filter({hasText:'3 supported fields'})).toBeVisible();
}
async function interpret() {
  const editor=panel.getByLabel('Edited answer for this form');
  await editor.fill('My full name is Alex Thomas. My email address is alex@example.test.');
  // The panel is a test extension tab; preserve the real form as active tab.
  await page.bringToFront();
  await panel.getByRole('button',{name:'Interpret edited answer',exact:true}).evaluate(button=>button.click());
}
test.afterEach(async()=>{
  try {
    if(page&&!page.isClosed()) {
      await expect(page.getByLabel('Full name',{exact:true})).toHaveValue('original name');
      await expect(page.getByLabel('Email address',{exact:true})).toHaveValue('original@example.test');
      expect(await page.evaluate(()=>window.events)).toEqual([]);
    }
    if(panel&&!panel.isClosed()) expect(await panel.evaluate(()=>window.__violations)).toEqual([]);
    if(worker) {
      expect(await worker.evaluate(async()=>Object.keys(await chrome.storage.session.get(null)).every(key=>['piko.localService.session.v1','piko.assistant.session.v1'].includes(key)))).toBe(true);
      expect(await worker.evaluate(async()=>((await chrome.storage.session.get('piko.assistant.session.v1'))['piko.assistant.session.v1']?.facts??[]))).toEqual([]);
      expect(await worker.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)))).toEqual([]);
    }
    if(page)expect(requests.every(r=>r.url===page.url() || r.worker&&r.url.startsWith(`${base}/v1/`))).toBe(true);
  } finally {
    await context?.close();context=undefined;page=undefined;panel=undefined;worker=undefined;
    if(service){const exited=once(service,'exit');service.kill();await exited;service=undefined;}
    if(fixture)await new Promise(resolve=>fixture.close(resolve));fixture=undefined;
    if(ollama)await new Promise(resolve=>ollama.close(resolve));ollama=undefined;
  }
});
test('authenticated interpretation populates editable review controls without selecting, approving or modifying the page',async({},info)=>{
  await start();await interpret();
  await expect(panel.getByLabel('Interpretation feedback')).toContainText('2 validated proposals');
  await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Alex Thomas');
  await expect(panel.getByLabel('Proposed value for Email address · email')).toHaveValue('alex@example.test');
  await expect(panel.getByRole('checkbox',{name:'Include Full name',exact:true})).not.toBeChecked();
  await expect(panel.getByRole('checkbox',{name:'Allow overwrite for Full name',exact:true})).not.toBeChecked();
  await expect(panel.getByRole('button',{name:'Review selected values',exact:true})).toBeDisabled();
  await expect(panel.getByLabel('Interpretation feedback')).toContainText('What should I enter for Department?');
  expect(modelCalls.length).toBe(1);
  const sent=JSON.parse(modelCalls[0].messages[1].content);
  expect(Object.keys(sent)).toEqual(['transcript','knownFacts','fields']);
  expect(JSON.stringify(sent)).not.toContain('PRIVATE');expect(JSON.stringify(sent)).not.toContain('original');
  expect(sent.fields).toHaveLength(3);expect(sent.knownFacts).toEqual([]);expect(modelCalls[0].format.properties.updates.items.anyOf).toHaveLength(3);
  await panel.getByText('Source evidence for proposals',{exact:true}).click();
  await panel.screenshot({path:info.outputPath('local-interpretation-review.png'),fullPage:true});
  await panel.getByLabel('Proposed value for Full name · text').fill('Manual correction');
  await panel.getByRole('button',{name:'Discard interpreted answers',exact:true}).click();
  await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('Manual correction');
  await expect(panel.getByLabel('Proposed value for Email address · email')).toHaveValue('');
  for(const width of [280,360,480]){await panel.setViewportSize({width,height:800});expect(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
});
test('unknown model fields and invalid options fail closed while edited text remains available for retry',async()=>{
  await start();mode='unknown';await interpret();
  await expect(panel.getByRole('alert')).toContainText('unknown field');
  await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('');
  await expect(panel.getByLabel('Edited answer for this form')).toHaveValue(/Alex Thomas/);
  mode='option';await interpret();await expect(panel.getByRole('alert')).toContainText('unavailable choice');
  mode='ok';await interpret();await expect(panel.getByLabel('Interpretation feedback')).toContainText('2 validated proposals');
});
test('cancelling or changing the scan rejects late proposals without clearing the edited answer',async()=>{
  await start();mode='timeout';await interpret();
  await expect(panel.getByRole('button',{name:'Cancel interpretation',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Cancel interpretation',exact:true}).evaluate(button=>button.click());
  await expect(panel.getByRole('alert')).toContainText('cancelled');
  await expect(panel.getByLabel('Edited answer for this form')).toHaveValue(/Alex Thomas/);
  await panel.waitForTimeout(1500);
  await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('');
  await interpret();
  await page.evaluate(()=>{document.querySelector('input').setAttribute('readonly','');});
  await expect(panel.getByText('Scan is stale',{exact:true})).toBeVisible();
  await panel.waitForTimeout(1500);
  await expect(panel.getByLabel('Proposed value for Full name · text')).toHaveValue('');
});
test('real installed Qwen returns reviewed proposals through the production extension and authenticated companion',async()=>{
  test.skip(process.env.PIKO_TEST_REAL_QWEN!=='1','Opt in to local model inference');
  test.setTimeout(90000);
  await start(true);await interpret();
  // Transport smoke test: omissions are scored in the separate 40-case accuracy
  // gate. Here require a nonempty, supported result from the actual local model.
  await expect(panel.getByLabel('Interpretation feedback')).toContainText(/[12] validated proposals/,{timeout:70000});
  const name = await panel.getByLabel('Proposed value for Full name · text').inputValue();
  const email = await panel.getByLabel('Proposed value for Email address · email').inputValue();
  expect(['', 'Alex Thomas']).toContain(name);
  expect(['', 'alex@example.test']).toContain(email);
  expect(Boolean(name || email)).toBe(true);
  await expect(panel.getByRole('button',{name:'Review selected values',exact:true})).toBeDisabled();
});
