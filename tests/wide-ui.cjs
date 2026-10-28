// Local-only geometry checks. No live services, scene downloads or agent commands.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
const { createServer } = require('../src/server');
// Measured before edits at fork-main b450879, same four workers, 900px viewport
// height and DPR=1. Both renderers stopped growing beyond the old shell limits.
const round4Baseline = { townRoofWidth:77.8522, person2D:41.366, desk2D:67.9143, person3D:33.2101, desk3D:56.2725 };
const source = new EventEmitter();
let count = 4;
source.sessions = () => Array.from({length:count},(_,i) => ({
  key:`wide-${i}`,id:`wide-${i}`,teamId:'wide',agent:['claude','codex','gemini'][i%3],
  displayName:`Member ${i}`,status:'tool',activity:'Read',role:i === 0 ? 'leader' : 'dev',
  source:'log',statusSource:'log',herdrStatus:'idle',lastEventAt:Date.now(),
}));
source.teams = () => ['wide','idle','unknown','empty'].map(id => ({id,name:`Garden ${id}`,presence:'fresh'}));
source.sourceInfo = () => ({presence:'fresh'});
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
}
async function ready(page) {
  await page.waitForFunction(() => typeof office !== 'undefined' && office?.framesShown > 4 && (officeKind === 'mid' || office.loaded));
  await settle(page);
}
async function metrics(page) {
  return page.evaluate(() => {
    const o = office;
    o.frame(performance.now());
    const p = o.people.get('wide-0');
    const bounds = pts => ({left:Math.min(...pts.map(v=>v.x)),right:Math.max(...pts.map(v=>v.x)),top:Math.min(...pts.map(v=>v.y)),bottom:Math.max(...pts.map(v=>v.y))});
    const dims = b => ({...b,width:b.right-b.left,height:b.bottom-b.top});
    let person, desk, room, geometry;
    if (o.gl) {
      o.scene.updateMatrixWorld(true); o.camera.updateMatrixWorld(true);
      const project = v => { v.project(o.camera); return {x:(v.x+1)*o.cw/2,y:(1-v.y)*o.ch/2}; };
      const projectedMesh = obj => {
        const pts=[];
        obj.traverse(n => {
          if (!n.isMesh || !n.visible) return;
          for (let i=0;i<n.geometry.attributes.position.count;i++) {
            const v=o.camera.position.clone(); n.getVertexPosition(i,v); v.applyMatrix4(n.matrixWorld); pts.push(project(v));
          }
        });
        return dims(bounds(pts));
      };
      person=projectedMesh(o.actors.get(p.key).obj);
      desk=projectedMesh(o.wideTestDesks[0]);
      geometry=projectedMesh(o.room);
      const pts=[];
      for(const x of [0,o.plan.W]) for(const y of [0,o.plan.viewH||2.4]) for(const z of [0,o.plan.D]) pts.push(project(o.camera.position.clone().set(x,y,z)));
      room=dims(bounds(pts));
    } else {
      let head; const draw=o.person;
      o.person=function(person){const at=draw.call(this,person); if(person.key===p.key)head=at; return at;};
      o.frame(performance.now()); o.person=draw;
      const project=v=>({x:v.x*o.cam.zoom+o.cam.ox,y:v.y*o.cam.zoom+o.cam.oy});
      const foot=project(o.iso(p.x,p.y,0)), top=project(head);
      person={height:foot.y-top.y,width:26*o.cam.zoom};
      const dk=o.plan.desks[0], pts=[];
      for(const x of [dk.x,dk.x+1.4]) for(const y of [dk.y,dk.y+.8]) for(const z of [0,.79])pts.push(project(o.iso(x,y,z)));
      desk=dims(bounds(pts));
      const corners=[];
      for(const x of [0,o.plan.W])for(const y of [0,o.plan.D])for(const z of [0,2.4])corners.push(project(o.iso(x,y,z)));
      room=dims(bounds(corners));
    }
    const labels=[], fontPixels=[], badgePixels=[], bubble=o.bubble, roundRect=o.roundRect, fillText=o.ctx.fillText, agentBadge=o.agentBadge;
    let labelKey=null;
    o.bubble=function(p,at){labelKey=p.key;const r=bubble.call(this,p,at);labelKey=null;return r;};
    o.roundRect=function(x,y,w,h,...args){
      if(labelKey){const t=this.ctx.getTransform();const pts=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]].map(([x,y])=>({x:(t.a*x+t.c*y+t.e)/this.dpr,y:(t.b*x+t.d*y+t.f)/this.dpr}));labels.push({...bounds(pts),key:labelKey});}
      return roundRect.call(this,x,y,w,h,...args);
    };
    o.ctx.fillText=function(text,...args){
      if(labelKey&&String(text).includes('Member')){const t=this.getTransform();fontPixels.push(parseFloat(this.font.match(/[\d.]+px/)[0])*Math.hypot(t.c,t.d)/o.dpr);}
      return fillText.call(this,text,...args);
    };
    o.agentBadge=function(...args){const t=this.ctx.getTransform();badgePixels.push(18*Math.hypot(t.a,t.b)/this.dpr);return agentBadge.apply(this,args);};
    o.frame(performance.now()); o.bubble=bubble; o.roundRect=roundRect; o.ctx.fillText=fillText; o.agentBadge=agentBadge;
    const c=o.canvas, box=c.getBoundingClientRect(), root=o.root.getBoundingClientRect();
    return {viewport:innerWidth,quality:officeKind,plan:[o.plan.W,o.plan.D],cw:o.cw,ch:o.ch,zoom:o.gl?o.camera.zoom:o.cam.zoom,
      person,desk,room,geometry,labels,labelHits:o.labelHits,labelScale:o.labelScale,nameFontPx:Math.max(...fontPixels),badgePx:Math.max(...badgePixels),css:[box.width,box.height],buffer:[c.width,c.height],dpr:o.dpr,
      root:[root.width,root.height],gl:o.gl?{css:[o.gl.domElement.getBoundingClientRect().width,o.gl.domElement.getBoundingClientRect().height],buffer:[o.gl.domElement.width,o.gl.domElement.height]}:null,
      overflow:document.documentElement.scrollWidth>innerWidth, gutter:document.querySelector('.wrap').getBoundingClientRect().left};
  });
}
async function tagDesks(page) {
  await page.evaluate(async()=>{
    const {Office3D}=await import('/office3d.js'); if(Office3D.prototype.wideTagged)return;
    Office3D.prototype.wideTagged=true; const original=Office3D.prototype.place;
    Office3D.prototype.place=function(name,...args){const obj=original.call(this,name,...args); if(name==='desk'){this.wideTestDesks ||= [];this.wideTestDesks.push(obj);}return obj;};
  });
}
function assertContained(m, name) {
  const boxes=[m.room,m.geometry,...m.labels].filter(Boolean);
  for(const b of boxes) assert.ok(b.left>=-1&&b.top>=-1&&b.right<=m.cw+1&&b.bottom<=m.ch+1,`${name} clipped: ${JSON.stringify(b)} in ${m.cw}x${m.ch}`);
  assert.equal(m.overflow,false,`${name} horizontal overflow`);
  assert.deepEqual(m.css,[m.cw,m.ch]);
  assert.ok(Math.abs(m.buffer[0]-m.cw*m.dpr)<=1&&Math.abs(m.buffer[1]-m.ch*m.dpr)<=1,`${name} backing DPR`);
  if(m.gl) assert.deepEqual(m.gl.css,m.css,`${name} GL/overlay CSS coordinates`);
  assert.ok(Math.abs(m.nameFontPx-10*m.labelScale)<.01,`${name} effective name font scales as a group`);
  assert.ok(Math.abs(m.badgePx-18*m.labelScale)<.01,`${name} provider badge scales with the text`);
  for(const b of m.labels) {
    assert.ok(m.labelHits.some(h=>h.key===b.key&&Math.abs(h.x0-b.left)<.01&&Math.abs(h.x1-b.right)<.01&&Math.abs(h.y0-b.top)<.01&&Math.abs(h.y1-b.bottom)<.01),`${name} rendered label has an exact CSS hit rectangle`);
  }
}
async function assertLabelPicking(page, name) {
  const result=await page.evaluate(()=>{
    const o=office;
    o.frame(performance.now());
    const length=o.labelHits.length;
    o.frame(performance.now());
    const errors=[];
    if(o.labelHits.length!==length)errors.push('label hits accumulated across frames');
    const hit=o.labelHits.findLast(h=>h.kind==='name');
    if(!hit)return ['no owner name hit'];
    const originalHover=o.onHover, bodies=o.hit;
    let clicked;
    o.onHover=(s,at,click)=>{if(click)clicked=s?.key;};
    // Force a different body beneath the real visible name to prove label priority.
    o.hit=[{...hit,key:hit.key==='wide-0'?'wide-1':'wide-0'}];
    const r=o.canvas.getBoundingClientRect();
    o.canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+(hit.x0+hit.x1)/2,clientY:r.top+(hit.y0+hit.y1)/2}));
    if(clicked!==hit.key)errors.push(`name picked ${clicked}, expected ${hit.key}`);
    // Move one real owner label to the upper-left through the production bubble
    // function. This exercises the scaled clamp and its recorded screen rectangle.
    o.labelHits=[];
    o.ctx.save();o.ctx.setTransform(o.dpr,0,0,o.dpr,0,0);
    o.bubble(o.people.get('wide-0'),{x:0,y:0,act:'type'});
    o.ctx.restore();
    const moved=o.labelHits.findLast(h=>h.kind==='name');
    if(!moved||moved.x0<0||moved.y0<0||moved.x1>o.cw||moved.y1>o.ch)errors.push('shifted/scaled label clipped');
    if(moved){
      o.hit=[{...moved,key:'wide-1'}];clicked=undefined;
      o.canvas.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+(moved.x0+moved.x1)/2,clientY:r.top+(moved.y0+moved.y1)/2}));
      if(clicked!=='wide-0')errors.push('shifted name selected the body below it');
    }
    o.onHover=originalHover;o.hit=bodies;o.hoverKey=null;o.frame(performance.now());
    return errors;
  });
  assert.deepEqual(result,[],name);
}
(async()=>{
  const server=createServer(source);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.WMAD_BROWSER_EXECUTABLE});
    const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,reducedMotion:'reduce'});
    const base=`http://127.0.0.1:${server.address().port}`, errors=[],external=[];
    context.on('page',p=>p.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message);}));
    await context.route('**/*',route=>{
      const u=new URL(route.request().url());
      if(u.origin!==base&&!['blob:','data:'].includes(u.protocol)){external.push(u.href);return route.abort();}
      return route.continue();
    });
    const page=await context.newPage(), measured={town:[],mid:[],high:[]};
    await page.goto(base); await page.waitForSelector('.house');
    await page.locator('#townLayout [data-layout=wide]').click(); await settle(page);
    for(const width of [1440,1920,2560]) {
      await page.setViewportSize({width,height:900}); await settle(page);
      measured.town.push(await page.locator('.house').first().evaluate(n=>{
        const svg=n.querySelector('.house-illustration'),roof=svg.querySelector('[fill="#738c70"]'),r=roof.getBoundingClientRect();
        return {viewport:innerWidth,svgHeight:svg.getBoundingClientRect().height,roof:[r.width,r.height],mapWidth:document.querySelector('.town-map').getBoundingClientRect().width};
      }));
    }
    await page.goto(`${base}/office?team=wide&quality=mid`); await ready(page);
    await page.locator('[data-scale=wide]').click(); await settle(page);
    for(const quality of ['mid','high']) {
      if(quality==='high'){await tagDesks(page);await page.click('#qualSeg [data-v=high]');await ready(page);}
      for(const width of [1440,1920,2560]) {
        await page.setViewportSize({width,height:900}); await settle(page);
        // Legacy camera eases towards its target; baseline gets the same settled view.
        await page.evaluate(()=>{for(let i=0;i<100;i++)office.fitCamera?.();});
        measured[quality].push(await metrics(page));
        await assertLabelPicking(page,`${quality} ${width} label picking`);
      }
    }
    for(const kind of ['town','mid','high']) {
      const list=measured[kind];
      for(let i=1;i<list.length;i++) {
        if(kind==='town') assert.ok(list[i].roof[0]>list[i-1].roof[0]*1.15,'real SVG roof grows');
        else {
          assert.ok(list[i].person.height>list[i-1].person.height*1.25,`${kind} actual person grows`);
          assert.ok(list[i].desk.width>list[i-1].desk.width*1.25,`${kind} actual furniture grows`);
          assert.deepEqual(list[i].plan,list[0].plan,'viewport does not create a different floor plan');
          assert.ok(list[i].labelScale>list[i-1].labelScale,`${kind} label scale grows with actual canvas`);
          assert.ok(list[i].nameFontPx>list[i-1].nameFontPx,`${kind} name text grows in CSS pixels`);
        }
      }
    }
    assert.ok(measured.mid[1].person.height>round4Baseline.person2D*1.25);
    assert.ok(measured.high[1].person.height>round4Baseline.person3D*1.25);
    assert.ok(measured.mid[2].zoom>2,'2D no longer has an arbitrary 2x cap');
    for(const kind of ['mid','high']) for(const m of measured[kind]) {
      assertContained(m,`${kind} ${m.viewport}`);
      assert.ok(m.room.width/m.cw>=.88&&m.room.width/m.cw<=.96,'room fills width without crop');
      assert.equal(m.gutter,m.viewport>=2240?40:32);
      assert.ok(m.labelScale>=1.2&&m.labelScale<=1.6);
    }
    assert.ok(Math.abs(measured.mid[2].ch-measured.high[2].ch)<=1,'quality shares one stage');
    // The large canvas is a real, scroll-accessible element; the wheel is not
    // swallowed by OrbitControls and all the room remains in the canvas.
    await page.evaluate(()=>scrollTo(0,0));
    await page.locator('#office').hover({position:{x:300,y:300}}); await page.mouse.wheel(0,600);
    await page.waitForFunction(()=>scrollY>100);
    await page.locator('#office').evaluate(n=>scrollTo(0,n.getBoundingClientRect().bottom+scrollY-innerHeight));
    assert.ok(await page.locator('#office').evaluate(n=>n.getBoundingClientRect().bottom<=innerHeight+1));
    await page.locator('[data-scale=fit]').click(); await settle(page);
    const fit=await metrics(page); assertContained(fit,'desktop fit'); assert.ok(fit.ch<measured.high[2].ch);
    await page.locator('[data-scale=wide]').click(); await settle(page);
    // No reallocation of the pixel buffer on unchanged SSE/render calls.
    const reallocations=await page.evaluate(async()=>{
      let writes=0; const proto=HTMLCanvasElement.prototype;
      const width=Object.getOwnPropertyDescriptor(proto,'width'),height=Object.getOwnPropertyDescriptor(proto,'height');
      for(const [key,d] of [['width',width],['height',height]])Object.defineProperty(proto,key,{...d,set(v){if(this===office.canvas||this===office.gl?.domElement)writes++;d.set.call(this,v);}});
      try{for(let i=0;i<20;i++)render();await new Promise(r=>setTimeout(r,1000));return writes;}
      finally{Object.defineProperty(proto,'width',width);Object.defineProperty(proto,'height',height);}
    });
    assert.equal(reallocations,0,'unchanged render preserves buffers');
    // Main and PiP use independent modes and viewport sizes, with real Document PiP.
    await page.locator('#pipBtn').click(); await page.waitForFunction(()=>!!popout.win);
    const pip=context.pages().find(p=>p!==page);
    await pip.waitForSelector('iframe');
    const child=pip.frames().find(f=>f.url().includes('pip=1')); await ready(child); await tagDesks(child);
    const pipResults=[];
    for(const quality of ['mid','high']) {
      await child.locator(`#qualSeg [data-v=${quality}]`).click(); await ready(child);
      for(const [width,height] of [[320,240],[480,400],[640,480],[960,600],[1280,720]]) {
        await pip.setViewportSize({width,height}); await settle(child);
        const m=await metrics(child); assertContained(m,`PiP ${quality} ${width}`); pipResults.push({quality,width,height,canvas:[m.cw,m.ch]});
        assert.equal(m.labelScale,1,'PiP preserves original label size');
        await assertLabelPicking(child,`PiP ${quality} ${width} name picking`);
        assert.ok(m.ch<height&&m.cw<=width);
        assert.equal(await child.locator('#stageScale').isVisible(),false);
        assert.equal(await child.locator('#teamRoster').isVisible(),false);
      }
    }
    await pip.close(); await page.waitForFunction(()=>!popout.win&&office.visible); await ready(page);
    assert.equal(await page.locator('#office').getAttribute('data-scale'),'wide');
    assert.ok((await metrics(page)).ch>1000,'main large stage restored');
    // Video fallback keeps stream lifecycle, scene aspect and both real layers.
    await page.evaluate(()=>Object.defineProperty(documentPictureInPicture,'requestWindow',{configurable:true,value:undefined}));
    await page.locator('#pipBtn').click(); await page.waitForFunction(()=>!!popout.stream);
    await page.waitForTimeout(200);
    const capture=await page.evaluate(()=>{
      const layers=[],c=popout.captureContext,draw=c.drawImage;
      c.drawImage=function(source,...args){layers.push(source===office.canvas?'overlay':source===office.gl?.domElement?'gl':'other');return draw.call(this,source,...args);};
      office.frame(performance.now());c.drawImage=draw;
      window.savedStream=popout.stream;
      return {size:[popout.captureCanvas.width,popout.captureCanvas.height],aspect:office.cw/office.ch,layers};
    });
    assert.deepEqual(capture.layers,['gl','overlay']);
    assert.ok(Math.abs(capture.size[0]/capture.size[1]-capture.aspect)<.005);
    assert.equal(Math.max(...capture.size),1280);
    await page.setViewportSize({width:1920,height:900});await settle(page);await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>savedStream===popout.stream),true);
    const tracks=await page.evaluateHandle(()=>popout.stream.getTracks());
    await page.locator('#closePreview').click();
    assert.equal(await tracks.evaluate(ts=>ts.every(t=>t.readyState==='ended')),true);
    // Small screens keep a short stage with the roster below, not a skinny side canvas.
    for(const quality of ['mid','high']) {
      await page.locator(`#qualSeg [data-v=${quality}]`).click();await ready(page);
      for(const width of [1199,900,390,320]) {
        await page.setViewportSize({width,height:width===320?568:844});await settle(page);
        const m=await metrics(page);assertContained(m,`small ${quality} ${width}`);
        assert.equal(m.labelScale,1,'small viewports preserve original label size');
        await assertLabelPicking(page,`small ${quality} ${width} name picking`);
        assert.ok(m.ch<850);
        if (width < 1024) assert.equal(await page.locator('#teamRoster').evaluate(n=>n.getBoundingClientRect().top>=document.querySelector('#office').getBoundingClientRect().bottom),true);
      }
    }
    // Plan growth is driven by workers only, and its full room still fits.
    await page.setViewportSize({width:1920,height:900});
    for(const n of [1,9,24,48]) {
      count=n;source.emit('change');await page.waitForFunction(n=>state.data.sessions.length===n,n);await settle(page);
      try { await page.waitForFunction(()=>office.builtPlan===office.plan&&office.actors.has('wide-0')); }
      catch(e) {
        console.error('Growth fixture diagnostics',n,await page.evaluate(()=>({kind:officeKind,visible:office.visible,dead:office.dead,loaded:office.loaded,people:[...office.people.keys()],actors:[...office.actors.keys()],built:office.builtPlan===office.plan})));
        throw e;
      }
      assertContained(await metrics(page),`3D ${n} workers`);
    }
    count=4;source.emit('change');
    // No hidden sidebar track on the all-office page; DPR=2 redraws rather than
    // CSS-stretching the old bitmap. Pixel limits are exercised at 2560 wide.
    const retina=await browser.newContext({viewport:{width:2560,height:1440},deviceScaleFactor:2});
    await retina.route('**/*',route=>{
      const u=new URL(route.request().url());return u.origin===base||['blob:','data:'].includes(u.protocol)?route.continue():route.abort();
    });
    const all=await retina.newPage();await all.goto(`${base}/office?quality=mid`);await ready(all);
    const all2d=await metrics(all);assertContained(all2d,'all-office retina');assert.ok(all2d.cw>2400);
    await assertLabelPicking(all,'DPR2 2D label picking');
    await tagDesks(all);await all.locator('#qualSeg [data-v=high]').click();await ready(all);
    const all3d=await metrics(all);assertContained(all3d,'all-office 3D retina');
    await assertLabelPicking(all,'DPR2 3D label picking');
    assert.ok(all3d.gl.buffer[0]*all3d.gl.buffer[1]<=12010000,'GL pixel budget');
    await retina.close();
    const compact = list => list.map(m=>({viewport:m.viewport,canvas:[m.cw,m.ch],personHeight:+m.person.height.toFixed(2),deskWidth:+m.desk.width.toFixed(2),roomWidth:+m.room.width.toFixed(2),zoom:+m.zoom.toFixed(3),labelScale:+m.labelScale.toFixed(3),nameFontPx:+m.nameFontPx.toFixed(2),badgePx:+m.badgePx.toFixed(2)}));
    console.log(JSON.stringify({baseline:round4Baseline,town:measured.town,mid:compact(measured.mid),high:compact(measured.high),pip:pipResults},null,2));
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('PASS wide: actual SVG/person/furniture growth; scaled text/badges/bubbles + exact label picking; room + mesh + labels contained; natural scroll + fit; stable buffers; mobile + real PiP + video; plan growth; DPR2 and pixel budget');
  } finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
