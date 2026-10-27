// UI-only fixture: synthetic rule metadata/content. Never reads repo rules or cwd.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
const publicDir = path.join(__dirname, '../public');
const marker = 'RULE_BODY_SENTINEL_SYNTHETIC';
const a = { id:'a'.repeat(40), path:'AGENTS.md', scope:'主仓库', size:2048 };
const b = { id:'b'.repeat(40), path:'AGENTS.md', scope:'成员工作树 A', size:40 };
const c = { id:'c'.repeat(40), path:`docs/TEAM-${'very-long-name-'.repeat(12)}.md`, scope:'手动配置范围', size:40 };
const attack = [
  `# ${marker}`, '', 'A **bold** word, *emphasis*, __strong__, _italic_ and `inline code`.', '',
  '- First rule', '- Second rule', '', '1. Ordered rule', '2. Another rule', '', '> Quoted text', '',
  '<script>window.rulesXss = 1</script>', '<img src="https://beacon.invalid/image" onerror="window.rulesXss=2">',
  '<svg onload="window.rulesXss=3"><image href="/beacon"></image></svg>', '<style>body{background:url(https://beacon.invalid/css)}</style>',
  '<iframe src="http://127.0.0.1:4545/beacon"></iframe>', '<input id="rules-entry" name="teamOffice">', '',
  '![remote](https://beacon.invalid/md) ![relative](/beacon) ![local](http://127.0.0.1:4545/api/sessions)',
  '![data](data:image/svg+xml,test) ![reference][pic]', '',
  '[unsafe](javascript:alert(1)) [command](command:run) [relative](/api/rules/file) [remote](https://beacon.invalid/link)',
  'https://beacon.invalid/plain', '', '```sh', 'echo "do not execute"', '<img src="/code-beacon">', '```',
].join('\n');
const source = new EventEmitter();
source.sessions = () => [{id:'fixture-agent',key:'fixture-agent',teamId:'fixture',displayName:'Fixture member',agent:'codex',status:'tool',statusSource:'log',lastEventAt:Date.now()}];
source.teams = () => [{id:'fixture',name:'合成团队 / Synthetic team',presence:'fresh'}];
const read = (file, content) => ({path:file.path,scope:file.scope,content,readAt:'2026-10-27T06:00:00Z'});
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };
async function settle(page) { await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))); }

(async()=>{
  const server = createServer(source);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:process.env.WMAD_BROWSER_EXECUTABLE});
    const context = await browser.newContext({viewport:{width:1440,height:900},locale:'zh-CN'});
    const base = `http://127.0.0.1:${server.address().port}`;
    const calls=[],assets=[],unexpected=[],errors=[],logs=[];
    let enabled=true, listValue={files:[a,b,c],warnings:[],scopeCount:3}, listError=null, fileError=null;
    let contents=new Map([[a.id,attack],[b.id,'# NEW_B\n\nOnly B content.'],[c.id,'']]);
    let heldList=null; const heldFiles=new Map();
    context.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>logs.push(m.text()));});
    await context.addInitScript(()=>{
      const fetchOriginal=window.fetch;
      window.ruleFetches=[];window.ruleAborts=0;window.ignoreRuleAbort=false;
      window.fetch=function(input,options={}){
        const u=new URL(typeof input==='string'?input:input.url,location.href);
        if(u.pathname.startsWith('/api/rules')){
          ruleFetches.push({path:u.pathname,cache:options.cache,mode:options.mode,redirect:options.redirect,header:new Headers(options.headers).get('x-agent-office-rule-read')});
          options.signal?.addEventListener('abort',()=>ruleAborts++,{once:true});
          // Deliberately ignore cancellation in selected tests: generation checks
          // must reject stale responses even if the underlying read completes.
          if(ignoreRuleAbort){const {signal,...rest}=options;options=rest;}
        }
        return fetchOriginal.call(this,input,options);
      };
    });
    await context.route('**/*',async route=>{
      const request=route.request(),u=new URL(request.url());
      if(u.hostname.endsWith('.invalid')) {
        // A wholly mocked remote origin exercises the hostname gate without DNS/network.
        if(u.hostname!=='viewer.invalid'){unexpected.push(u.href);return route.abort();}
        if(u.pathname.startsWith('/api/rules')||u.pathname.startsWith('/rules-ui')){unexpected.push(u.href);return route.fulfill({status:404,body:''});}
        const staticFiles={'/office':'index.html','/office.js':'office.js','/popout.js':'popout.js','/i18n.js':'i18n.js','/team-office.css':'team-office.css'};
        if(staticFiles[u.pathname])return route.fulfill({status:200,contentType:u.pathname==='/office'?'text/html':u.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(publicDir,staticFiles[u.pathname]),'utf8')});
        if(u.pathname==='/events')return route.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({now:Date.now(),sessions:source.sessions(),teams:source.teams()})}\n\n`});
        if(u.pathname==='/api/scenes')return route.fulfill({json:{installed:[],available:[]}});
        if(u.pathname==='/api/version')return route.fulfill({json:{version:'fixture'}});
        return route.fulfill({status:404,body:''});
      }
      if(!['127.0.0.1','localhost'].includes(u.hostname)||u.port!==String(server.address().port)) {unexpected.push(u.href);return route.abort();}
      if(['/rules-ui.js','/rules-ui.css'].includes(u.pathname)) {
        assets.push(u.pathname);
        return route.fulfill({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(publicDir,u.pathname.slice(1)),'utf8')});
      }
      if(u.pathname.startsWith('/api/rules')) {
        calls.push({path:u.pathname,team:u.searchParams.get('team'),id:u.searchParams.get('id'),header:request.headers()['x-agent-office-rule-read']});
        const json=async(value,status=200)=>{try{await route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(value)});}catch{/* Browser aborted this synthetic response. */}};
        if(u.pathname==='/api/rules/capabilities')return json({enabled});
        assert.equal(u.searchParams.get('team'),'fixture');
        if(u.pathname==='/api/rules') {
          const value=listValue,error=listError,hold=heldList;heldList=null;
          if(hold)await hold.promise;
          return json(error?{error:error.code}:value,error?.status||200);
        }
        if(u.pathname==='/api/rules/file') {
          const id=u.searchParams.get('id'),file=listValue.files.find(f=>f.id===id)||[a,b,c].find(f=>f.id===id);
          assert.match(id,/^[a-f0-9]{40}$/);
          const value=file?read(file,contents.get(id)||''):{error:'not_found'},error=fileError,hold=heldFiles.get(id);
          if(hold){heldFiles.delete(id);await hold.promise;}
          return json(error?{error:error.code}:value,error?.status||200);
        }
        return json({error:'not_found'},404);
      }
      if(u.pathname.includes('beacon')){unexpected.push(u.href);return route.abort();}
      return route.continue();
    });
    const page=await context.newPage();
    const open=async()=>{await page.locator('#rules-entry').click();await page.waitForSelector('#rules-dialog[open]');};
    const choose=async(index=0)=>{await page.locator('.rules-file').nth(index).click();await page.waitForFunction(()=>document.querySelector('.rules-reader').getAttribute('aria-busy')==='false');};
    const listCalls=()=>calls.filter(c=>c.path==='/api/rules').length;
    const fileCalls=()=>calls.filter(c=>c.path==='/api/rules/file').length;
    await page.goto(`${base}/office?team=fixture`);
    await page.waitForSelector('#rules-entry');await page.waitForFunction(()=>office?.framesShown>4);await settle(page);
    assert.equal(calls.length,1);assert.equal(listCalls(),0);assert.equal(fileCalls(),0);
    assert.deepEqual(assets.sort(),['/rules-ui.css','/rules-ui.js']);
    assert.equal(await page.locator('#rules-entry').getAttribute('aria-haspopup'),'dialog');
    const before=await page.evaluate(()=>{window.savedOffice=office;return [office.cw,office.ch,state.view,state.agent];});
    source.emit('change');await page.locator('#viewSeg [data-v=list]').click();await page.locator('#viewSeg [data-v=office]').click();await settle(page);
    assert.equal(listCalls(),0);assert.equal(fileCalls(),0,'SSE/view changes must not prefetch');
    await page.locator('#settingsMenu > summary').click();await open();
    await page.waitForSelector('.rules-file');
    assert.equal(await page.locator('#settingsMenu').getAttribute('open'),null);
    assert.equal(await page.evaluate(()=>office===savedOffice),true);
    assert.deepEqual(await page.evaluate(()=>[office.cw,office.ch,state.view,state.agent]),before);
    assert.equal(listCalls(),1);assert.equal(fileCalls(),0,'opening lists metadata only');
    assert.match(await page.locator('.rules-reader').innerText(),/选择一个文件/);
    await choose();
    assert.equal(fileCalls(),1);
    assert.equal(await page.locator('.rules-body h1').innerText(),marker);
    assert.equal(await page.locator('.rules-body strong').count(),2);
    assert.equal(await page.locator('.rules-body em').count(),2);
    assert.equal(await page.locator('.rules-body ul li').count(),2);
    assert.equal(await page.locator('.rules-body ol li').count(),2);
    assert.match(await page.locator('.rules-body pre code').innerText(),/do not execute/);
    assert.equal(await page.locator('.rules-body img,.rules-body a,.rules-body script,.rules-body style,.rules-body svg,.rules-body iframe,.rules-body input,.rules-body link,.rules-body form').count(),0);
    assert.equal(await page.locator('.rules-image-disabled').count(),5);
    assert.equal(await page.evaluate(()=>window.rulesXss),undefined);
    assert.match(await page.locator('.rules-body').innerText(),/<script>window.rulesXss/);
    await page.getByRole('button',{name:'原文',exact:true}).click();
    assert.equal(await page.locator('.rules-raw').textContent(),attack);
    await page.getByRole('button',{name:'阅读',exact:true}).click();assert.equal(fileCalls(),1,'view mode is local only');
    const privateState=await page.evaluate(()=>({snapshot:JSON.stringify(teamOffice.snapshot),storage:JSON.stringify({...localStorage,...sessionStorage})}));
    assert.equal(privateState.snapshot.includes(marker),false);assert.equal(privateState.storage.includes(marker),false);
    assert.equal(privateState.snapshot.includes(a.id),false);
    for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.querySelector('#rules-dialog').contains(document.activeElement)),true);}
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#rules-dialog').getAttribute('open'),null);
    assert.equal(await page.locator('.rules-body').textContent(),'');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'rules-entry');
    const closedReads=fileCalls();await open();await page.waitForSelector('.rules-file');assert.equal(fileCalls(),closedReads);
    // Empty file and finite error mapping; never reflect arbitrary backend strings.
    await choose(2);assert.match(await page.locator('.rules-body').innerText(),/此文件为空/);
    for(const status of [403,404,409,413,422,429,503]) {
      fileError={status,code:'/PRIVATE_SERVER_PATH'};await choose(0);
      assert.equal((await page.locator('.rules-body').innerText()).includes(marker),false);
      assert.equal((await page.locator('.rules-body').innerText()).includes('PRIVATE_SERVER_PATH'),false);
      assert.ok(await page.locator('.rules-body button').isVisible());
    }
    fileError=null;
    listError={status:503,code:'no_scope'};await page.getByRole('button',{name:'刷新列表',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('.rules-sidebar').getAttribute('aria-busy')==='false');
    assert.match(await page.locator('.rules-files').innerText(),/尚未确认/);
    listError=null;await page.locator('.rules-files button').click();await page.waitForSelector('.rules-file');
    listValue={files:[],warnings:[],scopeCount:0};await page.getByRole('button',{name:'刷新列表',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('.rules-sidebar').getAttribute('aria-busy')==='false');
    assert.match(await page.locator('.rules-sidebar').innerText(),/尚未确认/);
    listValue={files:[],warnings:[],scopeCount:1};await page.getByRole('button',{name:'刷新列表',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector('.rules-sidebar').textContent.includes('未找到规则文件'));
    listValue={files:[a,b,c],warnings:['partial'],scopeCount:3};await page.getByRole('button',{name:'刷新列表',exact:true}).first().click();await page.waitForSelector('.rules-file');
    assert.match(await page.locator('.rules-warning').innerText(),/不代表全部/);
    // Deliberately late A -> B, even when the transport ignores AbortSignal.
    await page.evaluate(()=>{ignoreRuleAbort=true;});
    let gate=deferred();heldFiles.set(a.id,gate);
    await page.locator('.rules-file').nth(0).click();await page.waitForFunction(()=>document.querySelector('.rules-reader').getAttribute('aria-busy')==='true');
    const aborted=await page.evaluate(()=>ruleAborts);
    await choose(1);assert.match(await page.locator('.rules-body').innerText(),/NEW_B/);
    gate.resolve();await page.waitForTimeout(60);await settle(page);
    assert.match(await page.locator('.rules-body').innerText(),/NEW_B/);assert.equal(await page.evaluate(()=>ruleAborts>0),true);
    assert.ok(await page.evaluate(n=>ruleAborts>n,aborted));
    // Refresh invalidates both the document and old file IDs/UI generation.
    gate=deferred();heldFiles.set(a.id,gate);await page.locator('.rules-file').nth(0).click();
    await page.getByRole('button',{name:'刷新列表',exact:true}).first().click();await page.waitForSelector('.rules-file');
    gate.resolve();await settle(page);assert.equal((await page.locator('.rules-body').innerText()).includes(marker),false);
    // Close while a document is in flight; reopening never resurrects it.
    gate=deferred();heldFiles.set(a.id,gate);await page.locator('.rules-file').nth(0).click();await page.keyboard.press('Escape');
    gate.resolve();await settle(page);assert.equal(await page.locator('.rules-body').textContent(),'');
    await open();await page.waitForSelector('.rules-file');assert.equal((await page.locator('.rules-body').innerText()).includes(marker),false);
    // Browser actually receives an abort for ordinary cancellation too.
    await page.evaluate(()=>{ignoreRuleAbort=false;});
    gate=deferred();heldFiles.set(a.id,gate);await page.locator('.rules-file').nth(0).click();await page.keyboard.press('Escape');
    gate.resolve();await settle(page);assert.equal(await page.locator('.rules-body').textContent(),'');
    // Delayed list, team change and bfcache cleanup carry no old content forward.
    heldList=deferred();const pendingList=heldList;await open();await page.keyboard.press('Escape');pendingList.resolve();await settle(page);
    assert.equal(await page.locator('.rules-files').textContent(),'');
    await open();await page.waitForSelector('.rules-file');await choose(0);
    await page.evaluate(()=>{history.pushState(null,'','/office?team=other');dispatchEvent(new PopStateEvent('popstate'));});
    assert.equal(await page.locator('#rules-entry').isVisible(),false);assert.equal(await page.locator('.rules-body').textContent(),'');
    await page.goto(`${base}/office?team=fixture`);await page.waitForSelector('#rules-entry');await open();await page.waitForSelector('.rules-file');await choose(0);
    const bfcacheReads=fileCalls();
    await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
    assert.equal(await page.locator('.rules-body').textContent(),'');assert.equal(fileCalls(),bfcacheReads);
    // Responsive layout, long code/body/path; local overflow only inside code blocks.
    const long='# Long rules\n\n'+('Long prose text '.repeat(500))+'\n\n```\n'+('wide-code-'.repeat(300))+'\n```';
    contents.set(c.id,long);listValue={files:[a,b,c],warnings:[],scopeCount:3};
    for(const width of [1440,1024,768,761,760,390,320]) {
      await page.setViewportSize({width,height:width===320?568:844});await open();await page.waitForSelector('.rules-file');
      if(width<=760){assert.equal(await page.locator('.rules-reader').isVisible(),false);assert.equal(await page.locator('.rules-sidebar').isVisible(),true);}
      await choose(2);await settle(page);
      const layout=await page.evaluate(()=>{const d=document.querySelector('#rules-dialog'),r=d.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:d.scrollWidth>d.clientWidth+1,left:r.left,right:r.right,code:document.querySelector('.rules-body pre').scrollWidth>document.querySelector('.rules-body pre').clientWidth};});
      assert.equal(layout.overflow,false);assert.equal(layout.dialogOverflow,false);assert.ok(layout.left>=-1&&layout.right<=width+1);assert.equal(layout.code,true);
      if(width<=760){assert.equal(await page.locator('.rules-sidebar').isVisible(),false);await page.getByRole('button',{name:'← 文件列表'}).click();assert.equal(await page.locator('.rules-sidebar').isVisible(),true);assert.equal(await page.locator('.rules-body').textContent(),'');}
      await page.keyboard.press('Escape');
    }
    await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await open();await page.waitForSelector('.rules-file');await choose(0);
    assert.equal(await page.locator('#rules-dialog').evaluate(n=>getComputedStyle(n).animationName),'none');
    await page.evaluate(()=>{
      const text=[...document.querySelectorAll('.rules-dialog *')].map(n=>[n,getComputedStyle(n).fontSize]);
      for(const [n,size] of text)n.style.fontSize=`${parseFloat(size)*2}px`;
    });
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('#rules-dialog').scrollWidth<=document.querySelector('#rules-dialog').clientWidth+1),true,'200% text fits');
    await page.evaluate(()=>{for(const n of document.querySelectorAll('.rules-dialog *'))n.style.fontSize='';});
    await page.keyboard.press('Escape');
    // Mobile back preserves the list position without retaining document content.
    listValue={scopeCount:1,warnings:[],files:Array.from({length:24},(_,i)=>({id:i.toString(16).padStart(40,'0'),path:`docs/TEAM-fixture-${i}.md`,scope:'主仓库',size:10}))};
    await open();await page.waitForSelector('.rules-file');
    const scroll=await page.locator('.rules-sidebar').evaluate(n=>{n.scrollTop=160;return n.scrollTop;});assert.ok(scroll>0);
    await page.locator('.rules-file').nth(4).evaluate(n=>n.click());await page.waitForFunction(()=>document.querySelector('.rules-reader').getAttribute('aria-busy')==='false');
    await page.getByRole('button',{name:'← 文件列表'}).click();
    assert.equal(await page.locator('.rules-sidebar').evaluate(n=>n.scrollTop),scroll);
    assert.equal(await page.locator('.rules-body').textContent(),'');await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>ruleFetches.every(r=>r.cache==='no-store'&&r.mode==='same-origin'&&r.redirect==='error'&&r.header==='1')),true);
    // Negative entry gates: not even capability or module requests are allowed.
    for(const url of [base+'/',base+'/office',base+'/office?team=ungrouped',base+'/office?team=fixture&pip=1','https://viewer.invalid/office?team=fixture']) {
      const previous=calls.length,previousAssets=assets.length;await page.goto(url);await page.waitForLoadState('load');await settle(page);
      assert.equal(await page.locator('#rules-entry').count(),0,url);assert.equal(calls.length,previous,url);assert.equal(assets.length,previousAssets,url);
    }
    enabled=false;let assetCount=assets.length;const capabilityDone=page.waitForResponse('**/api/rules/capabilities');await page.goto(`${base}/office?team=fixture`);await capabilityDone;await settle(page);assert.equal(await page.locator('#rules-entry').count(),0);assert.equal(assets.length,assetCount);
    enabled=true;await page.goto(`http://localhost:${server.address().port}/office?team=fixture`);await page.waitForSelector('#rules-entry');
    assert.ok(calls.every(c=>c.header==='1'));
    assert.equal(await page.evaluate(()=>ruleFetches.every(r=>r.cache==='no-store'&&r.mode==='same-origin'&&r.redirect==='error'&&r.header==='1')),true);
    assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);assert.equal(logs.some(text=>text.includes(marker)),false);
    console.log('PASS rules UI: local capability-only gate; zero list/body prefetch; safe Markdown/raw; inert HTML/images/links; errors/empty/scopes; abort + late-response generations; Escape/focus; mobile/dark/reduce; close/team/bfcache cleanup; PiP/remote hidden; no-store/header');
  } finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
