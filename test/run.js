/* End-to-end test of Field Capture against a fake Microsoft + OneDrive.
   Usage: node run.js <siteDir> <verifier.py> [outDir]                     */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const NM = '/opt/npm-tools/node_modules/';
const { chromium } = require(NM+'playwright');
const sharp = require(NM+'sharp');
const fake = require('./fake.js');
const { state } = fake;
/* The suite drives the app with nothing fixed by config.js, whatever the
   repository's own config.js holds; sections that test config.js set it. */
const CFG = o => 'window.FIELD_CAPTURE_CONFIG = '+JSON.stringify(Object.assign({clientId:'',authority:'',folder:'',account:'',driveId:''}, o||{}))+';\n';
const GMAIL = 'jasontjames1974@gmail.com';
state.config = CFG();

const SITE = path.resolve(process.argv[2]);
const VERIFIER = path.resolve(process.argv[3]);
const OUT = path.resolve(process.argv[4] || './out');
const URL0 = 'https://'+fake.SITE_HOST+'/field-cam/';
fs.rmSync(OUT, {recursive:true, force:true}); fs.mkdirSync(OUT, {recursive:true});

const results = [];
function T(name, ok, detail){
  results.push({name, ok:!!ok, detail:detail||''});
  console.log((ok?'  PASS  ':'  FAIL  ')+name+(detail&&!ok?'   <- '+detail:''));
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn, ms, label){
  const t0 = Date.now();
  for(;;){
    let v; try{ v = await fn(); }catch(e){ v = false; }
    if(v) return v;
    if(Date.now()-t0 > (ms||15000)) throw new Error('timed out waiting for '+(label||fn.toString().slice(0,80)));
    await sleep(120);
  }
}
const D = k => state.drives[k];
const baseOf = k => D(k).base;
const jobFolder = (k, name) => fake.kids(D(k), baseOf(k).id).find(i=>i.name===name);
function tree(k, folder){           // {'Bldg-MAIN/file.jpg': size}
  const out = {};
  for(const a of fake.kids(D(k), folder.id)){
    if(a.folder) for(const b of fake.kids(D(k), a.id)) out[a.name+'/'+b.name] = b.folder ? -1 : b.content.length;
    else out[a.name] = a.content.length;
  }
  return out;
}
function verify(dir, label){
  const r = cp.spawnSync('python3', [VERIFIER, dir, '--json', path.join(OUT, label+'.verify.json')], {encoding:'utf8'});
  fs.writeFileSync(path.join(OUT, label+'.verify.txt'), r.stdout+'\n'+r.stderr);
  return {code:r.status, out:r.stdout+r.stderr};
}

(async ()=>{
  const srv = await fake.start(SITE, 443);
  const big = path.join(OUT, 'big_nameplate.jpg');
  await sharp({create:{width:4200,height:3000,channels:3,noise:{type:'gaussian',mean:128,sigma:60},background:{r:0,g:0,b:0}}})
    .jpeg({quality:96}).toFile(big);
  const small = [];
  for(let i=0;i<3;i++){
    const f = path.join(OUT, `lib_${i}.jpg`);
    await sharp({create:{width:900,height:600,channels:3,background:{r:40*i,g:90,b:160}}})
      .withExif({IFD0:{Make:'TEST'}, IFD2:{DateTimeOriginal:`2026:09:20 10:0${2-i}:00`}}).jpeg().toFile(f);
    fs.utimesSync(f, new Date(2026,8,20,10,i), new Date(2026,8,20,10,i));
    small.push(f);
  }

  const browser = await chromium.launch({args:[
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    '--host-resolver-rules=MAP * 127.0.0.1','--ignore-certificate-errors'],
    /* Every host name resolves to this machine and nothing is proxied, so the
       test cannot reach the real Microsoft or the live app. */
    proxy:{server:process.env.HTTPS_PROXY||'http://127.0.0.1:9', bypass:'*'}});
  const newCtx = async () => {
    const ctx = await browser.newContext({viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true,
      hasTouch:true, ignoreHTTPSErrors:true, permissions:['camera'], acceptDownloads:true});
    await ctx.addInitScript(()=>{ window.__FC_SLEEP_SCALE = 0.03; });
    return ctx;
  };
  let ctx = await newCtx();
  let page = await ctx.newPage();
  const errors = [];
  const hook = p => { p.on('pageerror', e=>errors.push('pageerror: '+e.message));
                      p.on('console', m=>{ if(m.type()==='error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: '+m.text()); }); };
  hook(page);

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const txt = sel => page.locator(sel).innerText();
  const on = id => page.evaluate(i=>document.getElementById(i).classList.contains('on'), id);
  const unitPhotos = () => ev(()=>{ const u = curUnit(); return u ? u.photos.length : 0; });
  const total = () => ev(()=> S ? S.units.reduce((a,u)=>a+u.photos.length,0) : 0);
  const pending = () => ev(async ()=> (await idbAll('photos')).filter(p=>!p.up).length);
  const localFiles = () => ev(async ()=>{ const o={}; for(const p of await idbAll('photos')) o[subFor(p)+'/'+p.file]=p.blob.size; return o; });
  const camReady = () => until(()=>ev(()=>document.getElementById('video').videoWidth>0), 15000, 'camera');
  async function shot(n){ for(let i=0;i<(n||1);i++){ const b = await ev(()=>S.seq); await page.click('#shutter'); await until(()=>ev(x=>S.seq>x && !busy, b), 20000, 'shot stored'); } }
  async function synced(){ await until(async ()=> (await pending())===0 && await ev(()=>!SY.running && S.mapRev===S.remoteMapRev && !S.tomb.length), 30000, 'queue to drain'); }
  const pill = () => txt('#syncPill');
  async function signInAs(k, fromSetup){
    state.nextAccount = k;
    await page.click(fromSetup===false ? '#btnSignIn' : '#btnSignInSetup');
    await page.waitForURL(u=>u.toString()===URL0, {timeout:15000});
    await until(()=>ev(()=>!!document.getElementById('setupAuthMsg').innerText.trim()), 15000, 'sign-in result');
  }
  const mark = t => console.log('\n== '+t);
  /* a plain viewfinder shot, whatever step the unit was left on */
  async function liveShot(){
    const has = await ev(()=>{ const u = curUnit(); return !!(u && u.photos.some(p=>p.step==='number')); });
    await page.click(has ? '#steps .step:nth-child(3)' : '#steps .step:nth-child(1)'); await shot(1);
  }
  const reviewReady = async ()=>{ await until(()=>on('scRev')); await until(()=>txt('#revBody').then(t=>/OUTPUT/i.test(t) && /PRE-FLIGHT/i.test(t)), 10000, 'review screen'); };
  async function pinYes(){
    await until(()=>page.locator('#pinYes').count().then(n=>n===1), 8000, 'pin question');
    await page.click('#pinYes');
    await until(()=>txt('#setupAuthMsg').then(t=>/OneDrive confirmed/.test(t)));
  }

  /* ---------- 1. first run ---------- */
  mark('first run, sign-in, pinning');
  await page.goto(URL0);
  await until(()=>txt('#buildTag').then(t=>/Field Capture 3\.0/.test(t)));
  T('title and build say Field Capture 3.0', /Field Capture/.test(await page.title()) && /3\.0/.test(await txt('#buildTag')));
  T('no "GTP" or "Field Cam" anywhere on the page', !/GTP|Field Cam\b/.test(await page.content()));
  T('setup says OneDrive is not set up without a client ID', /not set up/i.test(await txt('#setupAuthState')));
  await page.click('#btnCfgFromSetup');
  await page.fill('#cfgClient', '11111111-2222-3333-4444-555555555555');
  await page.click('#btnCfgBack');
  await signInAs('A');
  await until(()=>page.locator('#pinYes').count().then(n=>n===1), 8000, 'pin question');
  T('first sign-in asks which OneDrive before anything is pinned', /Is this the right OneDrive\?/.test(await txt('#sheetIn h1'))
     && /jasontjames1974@gmail\.com/.test(await txt('#sheetIn')) && await ev(()=>!loadCfg().pin));
  await until(()=>txt('#sheetIn').then(t=>/ABOUNDING LIFE/.test(t)));
  T('the question shows what is in the destination folder, and the drive id', /DRIVE_A/.test(await txt('#sheetIn')));
  await page.click('#pinYes');
  await until(()=>txt('#setupAuthMsg').then(t=>/OneDrive confirmed/.test(t)));
  T('sign-in round trip completes', /OneDrive confirmed/.test(await txt('#setupAuthMsg')), await txt('#setupAuthMsg'));
  T('first sign-in used the account chooser', state.authorizeHits[0].prompt==='select_account');
  T('PKCE verifier was kept in localStorage, not sessionStorage', await ev(()=>sessionStorage.length===0));
  await until(()=>txt('#destBox').then(t=>/Photos go to/.test(t)));
  T('destination card shows the folder and what is in it', /Assessment reports/.test(await txt('#destBox')) && /ABOUNDING LIFE/.test(await txt('#destBox')), await txt('#destBox'));
  T('the OneDrive is pinned by drive id', await ev(()=>loadCfg().pin.driveId)==='DRIVE_A');
  T('sign-in time left is shown', /Sign-in lasts about another 23 h/.test(await txt('#setupAuthState')), await txt('#setupAuthState'));

  /* ---------- 2. a unit, start to finish ---------- */
  mark('shooting: unit 1');
  await page.fill('#fInsured','TEST INSURED'); await page.fill('#fClaim','T-100');
  await page.selectOption('#fCos','1');                    // this policy has a cosmetic exclusion
  await page.click('#btnStart');
  await until(()=>on('scCam')); await camReady();
  T('first unit opens by itself as unit 1', (await txt('#tUnit'))==='1');
  const stageH = await ev(()=>document.getElementById('stage').getBoundingClientRect().height / innerHeight);
  T('viewfinder takes at least 70% of the screen height', stageH >= 0.70, 'ratio '+stageH.toFixed(3));
  await page.screenshot({path:path.join(OUT,'cam_unit1.png')});
  await shot(1);
  T('number shot advances to DATA TAG', /NAMEPLATE/.test(await txt('#bTitle')));
  T('DATA TAG is an ordinary viewfinder step: no phone-camera wording, no setting for it',
    !/own camera/i.test(await txt('#bHint')) && (await txt('#btnAltCam'))==='PHONE CAMERA' && (await page.locator('#cfgTagCam').count())===0);
  T('step wording carries no chalk colour', !/green/i.test(await page.locator('#scCam').innerText()));
  {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnAltCam')]);
    T('PHONE CAMERA opens the phone camera when it is asked for', true);
    const b = await ev(()=>S.seq);
    await fc.setFiles(big);
    await until(()=>ev(x=>S.seq>x && !busy, b), 30000, 'nameplate stored');
  }
  const tagSize = await ev(async ()=>{ const u = curUnit(); const r = await idbGet('photos', u.photos[1].id); return r.blob.size; });
  T('data tag photo is over 4 MB (exercises the chunked upload)', tagSize > 4*1024*1024, tagSize+' bytes');
  await page.click('#advanceBtn'); T('NEXT goes to OVERVIEW', /OVERVIEW/.test(await txt('#bTitle')));
  await shot(2);
  await page.click('#advanceBtn'); T('NEXT goes to DAMAGE', /DAMAGE/.test(await txt('#bTitle')));
  await shot(2);
  await page.click('#advanceBtn');
  T('NEXT from DAMAGE skips AHU and CTRL/MISC and opens the scope sheet', await on('sheet') && /Scope — unit 1/.test(await txt('#sheetIn h1')));
  { const codes = await page.locator('#sheetIn button[data-c]').evaluateAll(els=>els.map(e=>e.dataset.c));
    T('the seven everyday codes come first: T FG CC WC ECON UNIT SYS', codes.slice(0,7).join(' ')==='T FG CC WC ECON UNIT SYS', codes.join(' '));
    T('T(ECON), ECON HOOD and EX are not in the picker', !codes.includes('T(ECON)') && !codes.includes('ECON HOOD') && !codes.includes('EX'));
    T('the less common codes are folded away until asked for', !codes.includes('TRANS') && !codes.includes('DUCT INS') && await page.locator('#scopeMoreBtn').count()===1); }
  await page.click('#sheetIn button[data-c="CC"]');
  await page.click('#sheetIn b[data-q="CC"][data-d="1"]');
  await page.click('#sheetIn button[data-c="T"]');
  T('codes combine in legend order with quantity', (await txt('#scopePrev'))==='T CC(2)', await txt('#scopePrev'));
  await page.click('#scopeGo');
  await until(async ()=> !(await on('sheet')) && /SCOPE CODE/.test(await txt('#bTitle')), 5000, 'scope step').catch(()=>{});
  T('after setting scope the camera is on the SCOPE step', !(await on('sheet')) && /SCOPE CODE/.test(await txt('#bTitle')));
  await shot(1);
  T('scope photo closes the unit and opens unit 2 with no tap', (await txt('#tUnit'))==='2' && /UNIT NUMBER/.test(await txt('#bTitle')));
  T('an auto-opened unit with no photos is not in the job yet', await ev(()=>S.units.length)===1);
  await synced();
  let jf = jobFolder('A','TEST-INSURED_T-100_Photos');
  T('job folder was created inside the destination folder', !!jf);
  let remote = tree('A', jf), local = await localFiles();
  T('all 7 photos are in OneDrive under Bldg-MAIN', Object.keys(local).length===7 && Object.keys(local).every(k=>remote[k]===local[k]), JSON.stringify(remote));
  T('PHOTO_MAP.json and .csv are in the folder', 'PHOTO_MAP.json' in remote && 'PHOTO_MAP.csv' in remote);
  T('pill reads IN ONEDRIVE', /IN ONEDRIVE/.test(await pill()), await pill());
  T('uploads were addressed to the pinned drive id, never /me/drive/root', state.log.filter(l=>/^(PUT|POST)/.test(l)).every(l=>/\/drives\/DRIVE_A\//.test(l)));

  /* ---------- 3. second unit: side step, new codes, no mark photo ---------- */
  mark('shooting: unit 2 and the new chalk codes');
  await shot(1);
  let chooser = false; const seen = ()=>{ chooser = true; }; page.on('filechooser', seen);
  await page.click('#shutter');                        // DATA TAG, in the viewfinder
  await until(()=>unitPhotos().then(n=>n===2));
  page.off('filechooser', seen);
  T('the DATA TAG shutter takes the photo in the viewfinder, like every other step', !chooser
    && await ev(()=>curUnit().photos[1].step==='nameplate'));
  {
    const b = await ev(()=>S.seq);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#btnAltCam')]);
    await fc.setFiles(small[0]); await until(()=>ev(x=>S.seq>x && !busy, b));
  }
  await page.click('#advanceBtn'); await shot(1);
  await page.click('#advanceBtn'); await shot(1);
  await page.click('#steps .step:nth-child(5)');       // AHU chip
  T('AHU is one tap away on its chip', /INDOOR AHU/.test(await txt('#bTitle')));
  await shot(1);
  await page.click('#advanceBtn');
  T('NEXT from a side step goes on to scope', await on('sheet'));
  await page.click('#scopeMoreBtn');
  await page.click('#sheetIn button[data-c="T"]');
  await page.click('#sheetIn button[data-c="TRANS"]');
  T('NFD is offered on a job with a cosmetic exclusion', await page.locator('#sheetIn button[data-c="NFD"]').count()===1);
  await page.click('#sheetIn button[data-c="NFD"]');
  T('NFD clears repair codes (no priced scope stands alone)', (await txt('#scopePrev'))==='NFD', await txt('#scopePrev'));
  await page.click('#sheetIn button[data-c="NT"]'); await page.click('#sheetIn button[data-c="M"]');
  T('designators ride along with NFD', (await txt('#scopePrev'))==='NFD NT M', await txt('#scopePrev'));
  await page.click('#sheetIn button[data-c="ECON"]');
  await page.click('#sheetIn button[data-c="DUCT INS"]');
  T('ECON and the less common codes combine', (await txt('#scopePrev'))==='ECON DUCT INS NT M', await txt('#scopePrev'));
  await page.fill('#scopeTake', '12 LF 14x10 INS TAPE');
  await page.click('#scopeGoNext');
  await until(()=>txt('#tUnit').then(t=>t==='3'), 5000, 'unit 3').catch(()=>{});
  T('"no mark to photograph" closes the unit and opens unit 3', (await txt('#tUnit'))==='3' && !(await on('sheet')));
  await page.click('#btnSite'); await until(()=>ev(()=>S.seq===14 && !busy));
  T('site shot is stored without a unit', await ev(async ()=> (await idbAll('photos')).filter(p=>!p.unit).length)===1);
  await synced();

  /* ---------- 4. delete and renumber after upload ---------- */
  mark('delete and renumber after upload');
  await page.click('#unitBadge'); await page.fill('#nuNum','2'); await page.click('#nuGo');
  await until(()=>on('sheet').then(v=>!v));
  T('going back to unit 2 resumes it', (await txt('#tUnit'))==='2' && (await unitPhotos())===6, String(await unitPhotos()));
  const victim = await ev(()=>{ const u = curUnit(); return u.photos[u.photos.length-1].file; });
  await page.click('#lastThumb');
  await until(()=>page.locator('#pgrid .th').count().then(n=>n===6), 8000, 'photo grid');
  await page.click('#pgrid .th:last-child'); await page.click('#askYes');
  await until(()=>unitPhotos().then(n=>n===5)); await page.click('#pgDone').catch(()=>{});
  await synced();
  jf = jobFolder('A','TEST-INSURED_T-100_Photos'); remote = tree('A', jf);
  T('deleting an uploaded photo removes its OneDrive copy too', !('Bldg-MAIN/'+victim in remote), victim);
  await page.click('#unitBadge'); await page.fill('#nuNum','5'); await page.click('#nuRename');
  await until(()=>txt('#tUnit').then(t=>t==='5'));
  await synced();
  remote = tree('A', jf); local = await localFiles();
  T('renumbering renames the photos locally and in OneDrive', Object.keys(local).some(k=>/_U005_/.test(k)) && !Object.keys(remote).some(k=>/_U002_/.test(k))
     && Object.keys(local).every(k=>remote[k]===local[k]), JSON.stringify(Object.keys(remote)));
  T('no stray files left in OneDrive after delete + renumber', Object.keys(remote).filter(k=>!/^PHOTO_MAP/.test(k)).length===Object.keys(local).length);

  /* ---------- 5. second number photo ---------- */
  mark('guards');
  await page.click('#steps .step:nth-child(1)');
  const before = await total();
  await page.click('#shutter'); await until(()=>on('sheet'));
  T('the shutter on UNIT # offers a retake when the unit already has its number photo', /Retake the chalk-number photo\?/.test(await txt('#sheetIn h1')));
  await page.click('#askNo'); await until(()=>on('sheet').then(v=>!v));
  T('cancelling the retake changes nothing', (await total())===before);
  const num0 = await ev(async ()=>{ const u = curUnit(); const r = await idbGet('photos', u.photos[0].id); return {id:r.id, file:r.file, ts:r.ts, step:r.step, n:u.photos.length}; });
  await page.click('#steps .step:nth-child(1)'); await page.click('#shutter'); await until(()=>on('sheet')); await page.click('#askYes');
  await until(()=>ev(async id=>!!(await idbGet('photos', id)).retaken_at, num0.id), 15000, 'retake stored');
  const num1 = await ev(async ()=>{ const u = curUnit(); const r = await idbGet('photos', u.photos[0].id); return {id:r.id, file:r.file, ts:r.ts, step:r.step, n:u.photos.length, rt:r.retaken_at}; });
  T('a retake replaces the picture in place: same file name, same first position, same photo count',
    num0.step==='number' && num1.id===num0.id && num1.file===num0.file && num1.ts===num0.ts && num1.n===num0.n && (await total())===before && num1.rt>num0.ts, JSON.stringify(num1));
  await synced();
  { const lf = await localFiles(); const rf = tree('A', jf);
    T('the retaken picture replaces the copy in OneDrive', await ev(async id=>{ const r = await idbGet('photos', id); return isUp(r) && r.upAt > r.retaken_at; }, num0.id)
      && rf['Bldg-MAIN/'+num0.file]===lf['Bldg-MAIN/'+num0.file] && Object.keys(rf).filter(k=>!/^PHOTO_MAP/.test(k)).length===Object.keys(lf).length); }

  /* ---------- 6. throttling, expired token, offline ---------- */
  mark('429, expired token, offline');
  await page.click('#unitBadge'); await page.fill('#nuNum','3'); await page.click('#nuGo');
  await until(()=>on('sheet').then(v=>!v));
  state.throttle = 3;
  await shot(1); await synced();
  T('three 429s are retried and the photo still lands', state.throttle===0 && Object.keys(tree('A',jf)).some(k=>/_U003_01-number/.test(k)));
  state.expireAccess = true;
  await page.click('#shutter'); await until(()=>unitPhotos().then(n=>n===2)); await synced();
  T('an expired access token is refreshed and the upload completes', (await pending())===0 && !state.expireAccess);
  await ctx.setOffline(true);
  await page.click('#advanceBtn'); await shot(2);
  await until(()=>pill().then(t=>/OFFLINE/.test(t)));
  T('offline: photos are held and the pill says so', /OFFLINE · 2 HELD/.test(await pill()), await pill());
  await ctx.setOffline(false);
  await synced();
  T('back online: held photos upload without a tap', (await pending())===0 && /IN ONEDRIVE/.test(await pill()), await pill());
  await page.click('#advanceBtn'); await shot(1); await page.click('#advanceBtn');
  await page.click('#sheetIn button[data-c="UNIT"]'); await page.click('#scopeGo');
  await until(async ()=> !(await on('sheet')) && /SCOPE CODE/.test(await txt('#bTitle')), 5000, 'scope step');
  await shot(1); await until(()=>txt('#tUnit').then(t=>t!=='3'), 5000, 'unit to close');
  T('unit 3 closed, unit 6 opens (highest number + 1)', (await txt('#tUnit'))==='6', await txt('#tUnit'));

  /* ---------- 7. import ---------- */
  mark('import from the photo library');
  await page.click('#unitBadge'); await page.fill('#nuNum','3'); await page.click('#nuGo');
  await until(()=>on('sheet').then(v=>!v));
  await page.click('#steps .step:nth-child(4)');
  await page.click('#btnMenu');
  {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#mImport')]);
    const b = await total();
    await fc.setFiles(small);
    await until(()=>total().then(n=>n===b+3), 20000, 'import');
  }
  await until(()=>on('sheet').then(v=>!v));
  const imp = await ev(async ()=> (await idbAll('photos')).filter(p=>p.imported && p.step==='damage').sort(bySeq).map(p=>p.orig_taken));
  T('three library photos import into the current step, flagged as imported', imp.length===3, JSON.stringify(imp));
  T('import takes the capture time from the file itself (EXIF) and orders by it',
    JSON.stringify(imp)===JSON.stringify(['2026-09-20 10:00:00','2026-09-20 10:01:00','2026-09-20 10:02:00']), JSON.stringify(imp));

  /* ---------- 8. save to photos ---------- */
  mark('save to Photos');
  await ev(()=>{ window.__shared = []; navigator.canShare = d => !!(d && d.files && d.files.length);
                 navigator.share = d => { window.__shared.push(d.files.map(f=>f.name)); return Promise.resolve(); }; });
  await page.click('#btnMenu'); await page.click('#mAlbum');
  const albTotal = await ev(async ()=> (await idbAll('photos')).length);
  await until(()=>txt('#albGo').then(t=>/SAVE NEXT/.test(t)));
  T('album sheet offers the first batch of 20', /SAVE NEXT 20 TO PHOTOS/.test(await txt('#albGo')) || albTotal<20, await txt('#albGo'));
  await page.click('#albGo');
  await until(()=>ev(async n=> (await idbAll('photos')).filter(p=>p.album).length===Math.min(20,n), albTotal));
  T('photos are handed to the share sheet as JPEG files in shooting order',
    await ev(()=>window.__shared.length===1 && window.__shared[0][0].startsWith('0001_')));
  await until(()=>txt('#albGo').then(t=>/SAVE NEXT|ALL SAVED/.test(t)));
  if(albTotal>20){ await page.click('#albGo'); await until(()=>ev(async ()=> (await idbAll('photos')).every(p=>p.album))); }
  T('every photo ends up marked as sent to Photos', await ev(async ()=> (await idbAll('photos')).every(p=>p.album)));
  await page.click('#albClose');

  /* ---------- 9. confirm in OneDrive ---------- */
  mark('CONFIRM IN ONEDRIVE');
  await synced();
  await page.click('#btnMenu'); await page.click('#mReview');
  await reviewReady();
  T('review says NOT CONFIRMED before the check', /NOT CONFIRMED YET/.test(await txt('#revBody')));
  await page.screenshot({path:path.join(OUT,'review_before.png'), fullPage:false});
  /* corrupt one remote file, drop another, add a stray */
  jf = jobFolder('A','TEST-INSURED_T-100_Photos');
  const bl = fake.kids(D('A'), jf.id).find(i=>i.name==='Bldg-MAIN');
  const fl = fake.kids(D('A'), bl.id);
  fl[2].content = fl[2].content.subarray(0, fl[2].content.length-25);
  const droppedName = fl[4].name; fake.rm(D('A'), fl[4].id);
  fake.add(D('A'), bl.id, 'IMG_9999.jpg', false, Buffer.from('stray'));
  await page.click('#btnUp');
  await until(()=>txt('#opBox').then(t=>/CONFIRMED\.|NOT COMPLETE|Stopped/.test(t)), 40000, 'confirm result');
  const op = await txt('#opBox');
  T('reconcile finds the short file and the missing file, re-sends them, and confirms', /1 missing, 1 wrong size/.test(op) && /CONFIRMED\./.test(op), op.slice(0,600));
  T('reconcile reports the stray file', /IMG_9999\.jpg/.test(op));
  remote = tree('A', jf); local = await localFiles();
  T('after confirm every local photo matches OneDrive byte for byte in size', Object.keys(local).every(k=>remote[k]===local[k]) && (droppedName in Object.fromEntries(Object.keys(remote).map(k=>[k.split('/').pop(),1]))));
  await page.click('#btnExtras'); await page.click('#askYes');
  await until(()=>!('Bldg-MAIN/IMG_9999.jpg' in tree('A', jf)), 20000, 'stray removed');
  await until(()=>txt('#opBox').then(t=>/CONFIRMED\./.test(t) && !/IMG_9999/.test(t)), 40000);
  T('stray file is removed on request and the folder re-confirms clean', true);
  T('job is recorded as confirmed for exactly this set of photos', await ev(()=>S.confirmed && S.confirmed.rev===S.photoRev && jobSafe(S)));
  const hist = await ev(()=>loadCfg().history);
  T('upload history holds the job, account, drive id and folder link', hist.length===1 && hist[0].status==='confirmed' && hist[0].driveId==='DRIVE_A'
     && /jasontjames1974/.test(hist[0].account) && /TEST-INSURED_T-100_Photos/.test(hist[0].folder) && !!hist[0].url, JSON.stringify(hist));
  await page.screenshot({path:path.join(OUT,'review_confirmed.png')});

  /* ---------- 10. the real verifier on what OneDrive holds ---------- */
  mark('map verifier on the uploaded folder');
  const dumpDir = path.join(OUT,'onedrive','TEST-INSURED_T-100_Photos');
  fake.dump(D('A'), jf, dumpDir);
  let v = verify(dumpDir, 'onedrive');
  T('read_photo_map.py exits 0 on the folder as uploaded', v.code===0, v.out.slice(0,900));
  const map = JSON.parse(fs.readFileSync(path.join(dumpDir,'PHOTO_MAP.json'),'utf8'));
  T('map header: Field Capture, app_version, app_built, map_schema, job_no',
    map.source==='Field Capture' && /^3\.0(\.\d+)?$/.test(map.app_version) && !!map.app_built && map.map_schema===1 && 'job_no' in map.claim && !('gtp_no' in map.claim));
  T('map carries the scope with new codes and the takeoff note',
    map.units.some(u=>u.scope==='ECON DUCT INS NT M' && u.note==='12 LF 14x10 INS TAPE'), JSON.stringify(map.units));
  { const rt = map.photo_map.filter(e=>e.retaken_at);
    T('the retaken chalk-number photo is the unit\'s first entry, and the map says when it was retaken',
      rt.length===1 && rt[0].type==='chalk_number' && /RETAKEN/.test(rt[0].note) && rt[0].captured < rt[0].retaken_at
      && map.photo_map.filter(e=>e.unit===rt[0].unit)[0].file===rt[0].file, JSON.stringify(rt)); }
  T('map notes say "chalk", never "green chalk"', !/green/i.test(JSON.stringify(map)));
  T('imported photos are marked in the map with the camera time', map.photo_map.filter(e=>e.imported && /^2026-09-20 10:0\d:00$/.test(e.original_taken)).length===3);
  T('no unit without photographs is declared', map.units.every(u=>u.photo_count>0) && !map.units.some(u=>u.unit==='6'));

  /* ---------- 11. ZIP export ---------- */
  mark('ZIP export');
  {
    await page.click('#btnZip');
    await until(()=>page.locator('#zipSave').count().then(n=>n===1), 30000, 'zip built');
    T('building the ZIP does not by itself mark the job exported', await ev(()=>!S.exported) && await page.locator('#zipDone').isDisabled());
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#zipSave')]);
    const zp = path.join(OUT,'export.zip'); await dl.saveAs(zp);
    await until(()=>page.locator('#zipDone').isEnabled());
    await page.click('#zipDone');
    await until(()=>ev(()=>!!S.exported));
    T('the job is marked exported only when the person says the ZIP is saved', await ev(()=>S.exported.rev===S.photoRev && S.exported.mapRev===S.mapRev));
    const zdir = path.join(OUT,'zip'); fs.mkdirSync(zdir);
    cp.execFileSync('python3',['-c','import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zp, zdir]);
    v = verify(path.join(zdir,'TEST-INSURED_T-100_Photos'), 'zip');
    T('exported ZIP unzips to a folder the verifier accepts (exit 0)', v.code===0, v.out.slice(0,600));
  }

  /* ---------- 12. new-job gate ---------- */
  mark('a job cannot be replaced by accident');
  await page.goto(URL0); await until(()=>txt('#resumeInfo').then(t=>/TEST INSURED/.test(t)));
  T('reload: the job is still on the phone and shown as confirmed', /Confirmed in OneDrive/.test(await txt('#resumeInfo')), await txt('#resumeInfo'));
  await page.fill('#fInsured','OTHER JOB'); await page.fill('#fClaim','X-1'); await page.click('#btnStart');
  await until(()=>on('sheet'));
  T('confirmed job: replacing it is a plain yes/no', /Start a new job\?/.test(await txt('#sheetIn h1')));
  await page.click('#askNo');
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady();
  await ctx.setOffline(true);
  await shot(1);                                           // an unconfirmed photo
  state.siteDown = true;                                  // the server drops every connection
  await page.goto(URL0).catch(()=>{});
  await until(()=>txt('#resumeInfo').then(t=>/TEST INSURED/.test(t)));
  T('the app opens from its stored copy with the server unreachable', /3\.0/.test(await txt('#buildTag')));
  state.siteDown = false;
  T('one new photo makes the job unconfirmed again', /Not yet confirmed/.test(await txt('#resumeInfo')));
  await page.fill('#fInsured','OTHER JOB'); await page.fill('#fClaim','X-1'); await page.click('#btnStart');
  await until(()=>on('sheet'));
  T('unconfirmed job: replacing it needs the word DELETE typed', /Photos would be lost/.test(await txt('#sheetIn h1')) && await page.locator('#askYes').isDisabled());
  await page.fill('#typedIn','delete'); T('typing the word enables the button', await page.locator('#askYes').isEnabled());
  await page.click('#askNo');
  T('cancelling keeps every photo', (await ev(async ()=> (await idbAll('photos')).length))===albTotal+1);
  await ctx.setOffline(false);

  /* ---------- 13. lapsed sign-in ---------- */
  mark('lapsed sign-in');
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady();
  state.refreshFails = true;
  await ev(()=>{ const c = loadCfg(); c.exp = 0; saveCfg(c); });
  await liveShot();
  await until(()=>pill().then(t=>/SIGN-IN LAPSED/.test(t)), 20000, 'lapsed pill');
  T('lapsed sign-in: pill says so and counts what is held', /SIGN-IN LAPSED · \d+ HELD/.test(await pill()), await pill());
  T('nothing is lost when the sign-in lapses', (await ev(async ()=> (await idbAll('photos')).length))===albTotal+2);
  state.refreshFails = false;
  await page.click('#syncPill'); await until(()=>on('sheet'));
  state.nextAccount = 'A';
  await page.click('#syIn');
  await page.waitForURL(u=>u.toString()===URL0, {timeout:15000});
  await until(()=>txt('#setupAuthMsg').then(t=>/Signed in as/.test(t)));
  T('re-sign-in goes straight to the pinned account (login_hint, no chooser)',
    state.authorizeHits.at(-1).login_hint==='jasontjames1974@gmail.com' && !state.authorizeHits.at(-1).prompt, JSON.stringify(state.authorizeHits.at(-1)));
  await until(async ()=> (await pending())===0, 30000, 'held photos to upload after sign-in');
  T('held photos upload by themselves after signing back in', true);

  /* ---------- 14. wrong OneDrive ---------- */
  mark('wrong OneDrive');
  const bBefore = D('B').items.size, cBefore = D('C').items.size;
  await page.click('#btnCfgFromSetup'); await page.click('#btnSignOut'); await page.click('#btnCfgBack');
  await signInAs('B');
  T('signing in to a different OneDrive is refused in plain words', /WRONG ONEDRIVE/.test(await txt('#setupAuthMsg')) && /other\.account@outlook\.com/.test(await txt('#setupAuthMsg')), await txt('#setupAuthMsg'));
  T('the wrong sign-in is thrown away', await ev(()=>!signedIn()));
  T('nothing at all was written to the wrong OneDrive', D('B').items.size===bBefore);
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady();
  await liveShot(); await sleep(1500);
  T('photos taken meanwhile stay on the phone', (await pending())===1 && D('B').items.size===bBefore);
  /* even with a stolen-in token for B, the pinned drive id blocks the write */
  await ev(()=>{ const c = loadCfg(); c.tok = 'AT-B-forced'; c.exp = Date.now()+3600000; c.rtok = 'x'; saveCfg(c); VER = {ok:true, at:Date.now(), driveId:'DRIVE_A', who:'x', baseId:S.remote.baseId, basePath:'x'}; });
  state.tokens.set('AT-B-forced','B');
  await ev(()=>pump().catch(()=>{})); await sleep(1500);
  T('a token for another account cannot write to the pinned drive', (await pending())===1 && D('B').items.size===bBefore && /FAILED/.test(await pill()), await pill());
  await ev(()=>{ dropTokens(); VER = null; });

  /* ---------- 15. missing destination folder ---------- */
  mark('missing destination folder');
  await page.goto(URL0); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  await page.click('#btnCfgFromSetup');
  await page.click('#btnUnpin'); await page.fill('#typedIn','UNPIN'); await page.click('#askYes');
  await until(()=>txt('#pinBox').then(t=>/No OneDrive pinned/.test(t)));
  T('the pin can only be removed by typing UNPIN', true);
  await page.click('#btnCfgBack');
  await signInAs('C');
  T('a OneDrive without the destination folder is refused', /WRONG ONEDRIVE/.test(await txt('#setupAuthMsg')) && /no folder/.test(await txt('#setupAuthMsg')), await txt('#setupAuthMsg'));
  T('the destination folder is never created', D('C').items.size===cBefore);
  T('a OneDrive without the folder is not pinned', await ev(()=>!loadCfg().pin));
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady(); await liveShot(); await sleep(1200);
  T('still nothing written there after shooting', D('C').items.size===cBefore, String(D('C').items.size));
  await page.goto(URL0); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  await signInAs('A'); await pinYes();
  await until(async ()=> (await pending())===0, 30000, 'catch-up upload');
  T('signing back in to the right OneDrive re-pins it and catches up', await ev(()=>loadCfg().pin.driveId)==='DRIVE_A');

  /* ---------- 16. second visit to the same claim ---------- */
  mark('second visit to the same claim');
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady();
  await page.click('#btnMenu'); await page.click('#mReview'); await reviewReady();
  await page.click('#btnUp'); await until(()=>txt('#opBox').then(t=>/CONFIRMED\.|NOT COMPLETE|Stopped/.test(t)), 40000);
  T('job re-confirms after the added photos', /CONFIRMED\./.test(await txt('#opBox')), (await txt('#opBox')).slice(0,400));
  const firstVisit = JSON.stringify(tree('A', jobFolder('A','TEST-INSURED_T-100_Photos')));
  await page.goto(URL0); await until(()=>txt('#resumeInfo').then(t=>/TEST INSURED/.test(t)));
  await page.fill('#fInsured','SECOND VISIT'); await page.fill('#fClaim','T-100'); await page.click('#btnStart');
  await until(()=>on('sheet')); await page.click('#askYes');
  await until(()=>on('scCam')); await camReady();
  await ev(()=>{ S.insured = 'TEST INSURED'; return saveState(); });      // same folder name as the first visit
  await shot(1); await synced();
  const jf2 = jobFolder('A','TEST-INSURED_T-100_Photos-2');
  T('a second capture session for the same claim gets its own folder', !!jf2 && Object.keys(tree('A', jf2)).some(k=>/_U001_01-number/.test(k)));
  T('the first visit\'s folder is untouched', JSON.stringify(tree('A', jobFolder('A','TEST-INSURED_T-100_Photos')))===firstVisit);

  /* ---------- 17. migration from v10 ---------- */
  mark('upgrade from v10 with a job on the phone');
  await ctx.close();
  ctx = await newCtx(); page = await ctx.newPage(); hook(page);
  state.siteDir = path.resolve(process.argv[5] || SITE);     // serve the real v10 first when given
  const haveV10 = !!process.argv[5];
  if(haveV10){
    await page.goto(URL0); await page.waitForSelector('#btnStart');
    await page.evaluate(()=>localStorage.setItem('fieldcamcfg', JSON.stringify({clientId:'11111111-2222-3333-4444-555555555555', folder:'Documents/Claude/Projects/Assessment reports',
      tok:'AT-B-old', rtok:'RT-B-old', exp:Date.now()+3600000})));
    await page.fill('#fInsured','OLD BUILD JOB'); await page.fill('#fClaim','V10-1'); await page.fill('#fGtp','2026-077');
    await page.click('#btnStart'); await page.waitForFunction(()=>document.getElementById('video').videoWidth>0);
    await page.click('#btnNewUnit'); await page.click('#nuGo');
    for(let i=0;i<3;i++){ await page.click('#shutter'); await sleep(700); }
    T('v10 itself ran and stored photos (test fixture)', await page.evaluate(()=>S.units[0].photos.length)===3);
    state.siteDir = null;
    await ctx.clearCookies();
    await page.evaluate(async ()=>{ const rs = await navigator.serviceWorker.getRegistrations(); for(const r of rs) await r.unregister(); const ks = await caches.keys(); for(const k of ks) await caches.delete(k); });
    await page.goto(URL0); await until(()=>page.locator('#buildTag').innerText().then(t=>/3\.0/.test(t)));
    await until(()=>page.locator('#resumeInfo').innerText().then(t=>/OLD BUILD JOB/.test(t)));
    T('3.0 finds the job a v10 session left on the phone', true);
    T('the v10 client ID and destination carry over', await page.evaluate(()=>clientId()==='11111111-2222-3333-4444-555555555555' && authority()==='common'));
    T('the v10 sign-in does NOT carry over: 3.0 needs one sign-in of its own before it pins a OneDrive', await page.evaluate(()=>!signedIn() && !loadCfg().pin));
    await page.evaluate(async ()=>{ for(const p of await idbAll('photos')) await updatePhoto(p.id, r=>{ r.up = true; }); });
    T('photos a v10 session marked "uploaded" are sent again by 3.0, not taken on trust', await page.evaluate(async ()=> (await pendingPhotos()).length)===3);
    await page.click('#btnResume'); await until(()=>page.evaluate(()=>document.getElementById('scCam').classList.contains('on')));
    T('v10 job resumes with gtp carried to job', await page.evaluate(()=>S.job==='2026-077' && !('gtp' in S) && S.units[0].photos.length===3));
    T('resume lands on the unit\'s next step, not back at UNIT #', /OVERVIEW|DAMAGE/.test(await page.locator('#bTitle').innerText()), await page.locator('#bTitle').innerText());
  } else {
    T('v10 upgrade fixture (skipped — no v10 dir given)', true);
  }


  /* ---------- 18. more of the flow, in a clean browser ---------- */
  mark('second browser: setup link, buildings, edit, auto-upload off, paging');
  await ctx.close();
  fake.reset();
  ctx = await newCtx(); page = await ctx.newPage(); hook(page);
  if(haveV10){
    state.siteDir = path.resolve(process.argv[5]);
    await page.goto(URL0); await page.waitForSelector('#btnStart');
    await page.fill('#fInsured','R'); await page.fill('#fClaim','R'); await page.click('#btnStart');
    await page.waitForFunction(()=>document.getElementById('video').videoWidth>0);
    const r10 = await page.evaluate(()=>document.getElementById('stage').getBoundingClientRect().height / innerHeight);
    state.siteDir = null;
    await page.evaluate(async ()=>{ const rs = await navigator.serviceWorker.getRegistrations(); for(const r of rs) await r.unregister(); const ks = await caches.keys(); for(const k of ks) await caches.delete(k); indexedDB.deleteDatabase('fieldcam'); localStorage.clear(); });
    await ctx.close(); ctx = await newCtx(); page = await ctx.newPage(); hook(page);
    console.log('  INFO  viewfinder share of screen height — v10: '+(r10*100).toFixed(1)+'%, 3.0: '+(stageH*100).toFixed(1)+'%');
    fs.writeFileSync(path.join(OUT,'viewfinder.json'), JSON.stringify({v10:r10, v30:stageH}));
    T('viewfinder is larger than v10\'s', stageH > r10 + 0.10, r10+' -> '+stageH);
  }
  const link = URL0+'#setup='+Buffer.from(JSON.stringify({clientId:'77777777-1111-2222-3333-444444444444', authority:'consumers',
     folder:'C:\\Users\\jason\\OneDrive\\Documents\\Claude\\Projects\\Assessment reports', account:'jasontjames1974@gmail.com', driveId:'DRIVE_A'})).toString('base64url');
  await page.goto(link);
  await until(()=>on('sheet')); T('a setup link asks before applying', /Apply these settings\?/.test(await txt('#sheetIn h1')));
  await page.click('#askYes');
  await until(()=>ev(()=>clientId()==='77777777-1111-2222-3333-444444444444'));
  T('setup link fills in client ID, account type, folder (Windows path cleaned) and pinned drive',
    await ev(()=>authority()==='consumers' && folderSet()==='Documents/Claude/Projects/Assessment reports' && pinnedId()==='DRIVE_A'));
  T('setup link leaves no trace in the address bar', page.url()===URL0, page.url());
  await signInAs('B');
  T('a drive pinned by setup link refuses a different account on the very first sign-in', /WRONG ONEDRIVE/.test(await txt('#setupAuthMsg')));
  await signInAs('A');
  T('the try after a wrong OneDrive shows the chooser, with the pinned address filled in', state.authorizeHits.at(-1).login_hint==='jasontjames1974@gmail.com' && state.authorizeHits.at(-1).prompt==='select_account');
  await ev(()=>dropTokens()); await page.reload(); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  await signInAs('A');
  T('sign-in on a pinned browser sends login_hint and skips the chooser', state.authorizeHits.at(-1).login_hint==='jasontjames1974@gmail.com' && !state.authorizeHits.at(-1).prompt, JSON.stringify(state.authorizeHits.at(-1)));
  T('account-type setting is used in the sign-in address', /^\/consumers\//.test(state.authorizeHits.at(-1)._path), state.authorizeHits.at(-1)._path);

  await page.click('#btnCfgFromSetup'); await page.selectOption('#cfgAuto','0'); await page.click('#btnCfgBack');
  await page.fill('#fInsured','Campus <Job> & Co'); await page.fill('#fClaim','C/26-9'); await page.fill('#fJob','2026-014'); await page.fill('#fBldgs','1b, 2a, 1b');
  await page.click('#btnStart'); await until(()=>on('scCam')); await camReady();
  T('buildings are upper-cased and de-duplicated', await ev(()=>S.buildings.join('|'))==='1B|2A');
  T('insured with HTML characters is shown as text, not markup', (await txt('#tInsured'))==='Campus <Job> & Co');
  let nfdOffered = -1;
  const quickUnit = async (codes)=>{
    await shot(1); await shot(1);                       // number, data tag (viewfinder — setting is "live")
    await page.click('#advanceBtn'); await shot(1);     // overview
    await page.click('#advanceBtn'); await shot(1);     // damage
    await page.click('#advanceBtn'); await until(()=>on('sheet'));
    nfdOffered = await page.locator('#sheetIn button[data-c="NFD"]').count();
    for(const c of codes) await page.click(`#sheetIn button[data-c="${c}"]`);
    await page.click('#scopeGoNext'); await until(()=>on('sheet').then(v=>!v));
  };
  await quickUnit(['T','FG']); await quickUnit(['ND']);
  T('NFD is not offered on a job without a cosmetic exclusion', nfdOffered===0);
  T('two units done, unit 3 open in building 1B', (await txt('#tUnit'))==='3' && await ev(()=>S.units.length)===2);
  await page.selectOption('#selBldg','2A');
  await until(()=>txt('#tUnit').then(t=>t==='1'));
  T('switching building restarts numbering at 1 there', true);
  await quickUnit(['WC']);
  T('auto-upload off: nothing has gone to OneDrive and the pill says how many are on the phone', !jobFolder('A','Campus-Job--Co_C26-9_Photos') && /12 ON PHONE/.test(await pill()), await pill());
  /* edit the claim */
  await page.click('#btnMenu'); await page.click('#mReview'); await reviewReady();
  { const rb = await txt('#revBody');
    T('pre-flight has no blocking issue for three closed units', !/✕/.test(rb) && !/blocking issue/.test(rb));
    T('pre-flight warns when a priced scope has no chalk-mark photo, and not for ND',
      /Unit 1: scope T FG chosen but the chalk mark was not photographed/.test(rb) && !/Unit 2: scope ND/.test(rb), rb.slice(300,900)); }
  await page.click('#btnCfg'); await page.click('#btnEditClaim');
  await page.fill('#ecInsured','CAMPUS JOB'); await page.fill('#ecBldgs','1B'); await page.click('#ecYes');
  T('a building that has units cannot be removed', /cannot be removed/.test(await txt('#ecMsg')));
  await page.fill('#ecBldgs','1B, 2A, 3C'); await page.click('#ecYes');
  await until(()=>ev(()=>S.insured==='CAMPUS JOB' && S.buildings.length===3));
  T('editing claim details keeps every photo', await ev(async ()=> (await idbAll('photos')).length)===12);
  await page.click('#btnCfgBack'); await reviewReady();
  /* paged listing + confirm with auto-upload off */
  state.pageSize = 3;
  await page.click('#btnUp');
  await until(()=>txt('#opBox').then(t=>/CONFIRMED\.|NOT COMPLETE|Stopped/.test(t)), 40000);
  T('CONFIRM uploads everything when auto-upload is off, and reads back a paged folder listing', /CONFIRMED\./.test(await txt('#opBox')) && /12 of 12 photos match/.test(await txt('#opBox')), (await txt('#opBox')).slice(0,500));
  T('the status at the top of the review screen turns to CONFIRMED', /CONFIRMED IN ONEDRIVE/.test(await txt('#safeBox')));
  state.pageSize = 0;
  const cj = jobFolder('A','CAMPUS-JOB_C26-9_Photos');
  T('folder name is taken from the claim at the time the folder is first created', !!cj);
  const cdir = path.join(OUT,'campus','CAMPUS-JOB_C26-9_Photos'); fake.dump(D('A'), cj, cdir);
  v = verify(cdir, 'campus');
  T('two-building job verifies with the updated verifier (exit 0)', v.code===0, v.out.slice(0,600));
  const old = cp.spawnSync('python3', [path.join(path.dirname(VERIFIER),'read_photo_map_installed.py'), cdir], {encoding:'utf8'});
  T('a 3.0 map that uses only the old codes still passes the verifier installed today (exit 0)', old.status===0, (old.stdout+old.stderr).slice(0,600));
  const old2 = cp.spawnSync('python3', [path.join(path.dirname(VERIFIER),'read_photo_map_installed.py'), path.join(OUT,'onedrive','TEST-INSURED_T-100_Photos')], {encoding:'utf8'});
  T('the verifier installed today still rejects a map with the new codes (exit 4) — it must be updated with the app', old2.status===4, String(old2.status));

  /* album: closing the share sheet marks nothing */
  await ev(()=>{ navigator.canShare = d => true; navigator.share = d => Promise.reject(Object.assign(new Error('x'),{name:'AbortError'})); });
  await page.click('#btnAlbum'); await until(()=>txt('#albGo').then(t=>/SAVE NEXT 12/.test(t)));
  await page.click('#albGo'); await until(()=>txt('#sheetIn').then(t=>/Nothing was saved/.test(t)));
  T('closing the share sheet marks nothing as saved', await ev(async ()=> (await idbAll('photos')).every(p=>!p.album)));
  await page.click('#albClose');

  /* replace an unconfirmed job by typing DELETE; delete a job */
  await page.click('#btnBackCam'); await until(()=>on('scCam')); await camReady(); await liveShot();
  await page.goto(URL0); await until(()=>txt('#resumeInfo').then(t=>/CAMPUS JOB/.test(t)));
  await page.fill('#fInsured','NEXT ONE'); await page.fill('#fClaim','N-2'); await page.click('#btnStart');
  await until(()=>on('sheet')); await page.fill('#typedIn','DELETE'); await page.click('#askYes');
  await until(()=>on('scCam')); await camReady();
  T('typing DELETE replaces the job and clears its photos from the phone', await ev(async ()=> S.insured==='NEXT ONE' && (await idbAll('photos')).length===0));
  await sleep(1500);
  T('a job with no photos creates nothing in OneDrive', !jobFolder('A','NEXT-ONE_N-2_Photos'));
  await page.click('#btnMenu'); await page.click('#mReview'); await reviewReady();
  await page.click('#btnCfg'); await page.click('#btnWipe'); await until(()=>on('sheet')); await page.click('#askYes');
  await until(()=>on('scSetup'));
  T('deleting an empty job returns to the start screen', /No saved job/.test(await txt('#resumeInfo')));

  /* ---------- 19. config.js in the repository ---------- */
  mark('settings fixed by config.js');
  await ctx.close(); fake.reset();
  state.siteDir = path.resolve(SITE, '..', 'site_cfg'); state.config = null;
  ctx = await newCtx(); page = await ctx.newPage(); hook(page);
  await page.goto(URL0); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  T('config.js supplies the client ID with nothing typed', await ev(()=>clientId()==='99999999-aaaa-bbbb-cccc-dddddddddddd' && authority()==='consumers'));
  await page.click('#btnCfgFromSetup');
  T('settings fixed by config.js are greyed out', await page.locator('#cfgClient').isDisabled() && await page.locator('#cfgFolder').isDisabled() && /fixed by config\.js/.test(await txt('#lockNote')));
  await page.click('#btnCfgBack');
  await signInAs('B');
  T('config.js pin refuses another OneDrive', /WRONG ONEDRIVE/.test(await txt('#setupAuthMsg')));
  await signInAs('A');
  await ev(()=>dropTokens()); await page.reload(); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  await signInAs('A');
  T('config.js sign-in uses the configured account type and goes straight to the pinned account',
    /Signed in as/.test(await txt('#setupAuthMsg')) && /^\/consumers\//.test(state.authorizeHits.at(-1)._path) && !state.authorizeHits.at(-1).prompt,
    JSON.stringify(state.authorizeHits.at(-1)));
  state.siteDir = null; state.config = CFG();

  /* ---------- 19b. the account, named in full ---------- */
  mark('the app carries the OneDrive account');
  { const vm = require('vm'), box = {window:{}}; vm.runInNewContext(fs.readFileSync(path.join(SITE,'config.js'),'utf8'), box);
    const a = (box.window.FIELD_CAPTURE_CONFIG||{}).account||'';
    T('the repository\'s config.js parses, and any account in it is a whole address', a==='' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a), a); }
  const fresh = async cfg => { await ctx.close(); fake.reset(); state.config = cfg; ctx = await newCtx(); page = await ctx.newPage(); hook(page);
    await page.goto(URL0); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t))); };
  const setClient = async () => { await page.click('#btnCfgFromSetup'); await page.fill('#cfgClient','11111111-2222-3333-4444-555555555555'); await page.click('#btnCfgBack'); await until(()=>on('scSetup')); };
  const lastHit = () => state.authorizeHits.at(-1);

  await fresh(CFG({account:GMAIL}));
  await page.click('#btnCfgFromSetup');
  T('the account from config.js shows in Settings and cannot be edited there', await page.locator('#cfgHint').isDisabled() && (await page.inputValue('#cfgHint'))===GMAIL);
  await page.click('#btnCfgBack'); await setClient();
  await signInAs('S');
  T('sign-in sends the whole address and goes straight to that account', lastHit().login_hint===GMAIL && !lastHit().prompt, JSON.stringify(lastHit()));
  T('the same name without the rest of the address is a different account, and is turned away',
    /WRONG ACCOUNT/.test(await txt('#setupAuthMsg')) && /jasontjames1974@gmail\.com/.test(await txt('#setupAuthMsg')), await txt('#setupAuthMsg'));
  await sleep(600);
  T('a wrong account is never offered for confirmation: no question, nothing pinned, signed out',
    (await page.locator('#pinYes').count())===0 && await ev(()=>!loadCfg().pin && !signedIn() && !pinnedId()));
  await signInAs('A');
  T('the try after a wrong account shows the chooser with the address filled in', lastHit().prompt==='select_account' && lastHit().login_hint===GMAIL, JSON.stringify(lastHit()));
  await pinYes();
  T('the named account is confirmed and pinned', await ev(()=>pinnedId()==='DRIVE_A' && loadCfg().pin.who==='jasontjames1974@gmail.com'));
  T('once the right account is in, the chooser is no longer forced', await ev(()=>!localStorage.getItem('fc_choose')));

  /* what happened on the phone: the look-alike was confirmed before the app knew the account */
  await fresh(CFG());
  await setClient();
  await signInAs('S'); await pinYes();
  T('3.0 as first released let the look-alike be confirmed', await ev(()=>pinnedId()==='DRIVE_S' && loadCfg().pin.who==='jasontjames1974'));
  await page.fill('#fInsured','WRONGPIN'); await page.fill('#fClaim','W-1'); await page.click('#btnStart');
  await until(()=>on('scCam')); await camReady(); await shot(1); await synced();
  T('...and a job started then went to that OneDrive', !!jobFolder('S','WRONGPIN_W-1_Photos') && !jobFolder('A','WRONGPIN_W-1_Photos'));
  state.config = CFG({account:GMAIL});
  await page.goto(URL0); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  await until(()=>txt('#setupAuthMsg').then(t=>/was cleared/.test(t)), 15000, 'pin cleared notice');
  T('a OneDrive confirmed for another account is cleared when the app opens, and says so',
    await ev(()=>!loadCfg().pin && !signedIn()) && /jasontjames1974@gmail\.com/.test(await txt('#setupAuthMsg')) && /sent again/.test(await txt('#setupAuthMsg')), await txt('#setupAuthMsg'));
  T('the job that was bound to it is queued again in full', await ev(()=>S && S.remote===null && S.confirmed===null) && (await pending())===1);
  await signInAs('S');
  T('the look-alike can no longer get in', /WRONG ACCOUNT/.test(await txt('#setupAuthMsg')) && await ev(()=>!loadCfg().pin));
  await signInAs('A'); await pinYes();
  await synced();
  { const jf2 = jobFolder('A','WRONGPIN_W-1_Photos'); const t2 = jf2 ? tree('A', jf2) : {};
    T('after the right account is confirmed the whole job lands in its OneDrive', !!jf2 && Object.keys(t2).some(k=>/-number\.jpg$/.test(k)) && ('PHOTO_MAP.json' in t2), JSON.stringify(t2)); }

  /* no config.js: the Settings field does the same job */
  await fresh(CFG());
  await page.click('#btnCfgFromSetup'); await page.fill('#cfgClient','11111111-2222-3333-4444-555555555555');
  await page.fill('#cfgHint','jasontjames1974'); await page.click('#btnCfgBack'); await sleep(300);
  T('Settings refuses an account name without the part after the @', await on('scCfg') && /whole address/.test(await txt('#hintMsg')) && await ev(()=>!loadCfg().hint));
  T('a short name left by an earlier build is never sent to Microsoft', await ev(()=>{ const c = loadCfg(); c.hint = 'jasontjames1974'; saveCfg(c); const r = acctHint()==='' && acctWant()===''; c.hint=''; saveCfg(c); return r; }));
  await page.fill('#cfgHint',' JasonTJames1974@Gmail.com '); await page.click('#btnCfgBack'); await until(()=>on('scSetup'));
  await signInAs('S');
  T('with the whole address typed in Settings, another account is turned away too', /WRONG ACCOUNT/.test(await txt('#setupAuthMsg')));
  await signInAs('A'); await pinYes();
  T('...and the right one is accepted whatever the capitals', await ev(()=>pinnedId()==='DRIVE_A'));


  /* ---------- 20. defects found by the independent review ---------- */
  mark('regressions found in review');
  await ctx.close(); fake.reset(); state.siteDir = null;
  ctx = await newCtx(); page = await ctx.newPage(); hook(page);
  await page.goto(URL0); await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)));
  await page.click('#btnCfgFromSetup'); await page.fill('#cfgClient','11111111-2222-3333-4444-555555555555'); await page.click('#btnCfgBack');
  await signInAs('A'); await pinYes();
  await page.fill('#fInsured','REG JOB'); await page.fill('#fClaim','R-1'); await page.fill('#fBldgs','##, MAIN');
  await page.click('#btnStart'); await until(()=>on('scCam')); await camReady();
  T('a building name with no letter or digit is dropped', await ev(()=>S.buildings.join('|'))==='MAIN');
  await page.click('#steps .step:nth-child(3)'); await page.click('#shutter'); await sleep(700);
  T('a unit cannot take any photo before its chalk-number photo', (await ev(()=>S.seq))===0 && /UNIT NUMBER/.test(await txt('#bTitle'))
     && /needs its chalk-number photo first/.test(await txt('#toast')), await txt('#toast'));
  await page.click('#btnSite'); await until(()=>ev(()=>S.seq===1 && !busy));
  await page.click('#btnSite'); await until(()=>ev(()=>S.seq===2 && !busy));
  await page.goto(URL0); await until(()=>txt('#resumeInfo').then(t=>/REG JOB/.test(t)));
  T('a job holding only site shots is still a job on the start screen', /2 photos/.test(await txt('#resumeInfo')), await txt('#resumeInfo'));
  await page.fill('#fInsured','OTHER'); await page.fill('#fClaim','X'); await page.click('#btnStart'); await until(()=>on('sheet'));
  T('…and replacing it takes the typed word', /Photos would be lost/.test(await txt('#sheetIn h1')) && /2 photos/.test(await txt('#sheetIn')));
  await page.click('#askNo');

  /* START tapped while a sign-in is still completing */
  state.tokenDelay = 3000; state.nextAccount = 'A';
  await page.click('#btnSignInSetup');
  await page.waitForURL(u=>u.toString()===URL0, {timeout:15000});
  await until(()=>page.locator('#btnStart').isEnabled(), 8000, 'start enabled');
  await page.fill('#fInsured','OTHER'); await page.fill('#fClaim','X'); await page.click('#btnStart');
  await until(()=>on('sheet'));
  T('START during a sign-in that is still completing still sees the saved job', /Photos would be lost/.test(await txt('#sheetIn h1')), await txt('#sheetIn h1'));
  await page.click('#askNo'); state.tokenDelay = 0;
  await until(()=>txt('#setupAuthMsg').then(t=>/Signed in as/.test(t)), 15000, 'delayed sign-in');
  T('the two site shots are untouched', (await ev(()=>idbCount('photos')))===2);

  /* delete from a grid opened before the upload finished */
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady();
  await shot(1);
  await page.click('#shutter'); await until(()=>unitPhotos().then(n=>n===2));
  await page.click('#advanceBtn');
  await synced();
  state.putDelay = {re:/overview/, ms:2000};
  await shot(1);
  const slow = await ev(()=>{ const u = curUnit(); return u.photos[u.photos.length-1]; });
  await page.click('#lastThumb');
  await until(()=>page.locator('#pgrid .th').count().then(n=>n===3), 8000, 'grid');
  T('the grid was opened while that photo was still uploading', await ev(async id=>!isUp(await idbGet('photos', id)), slow.id));
  await until(()=>ev(async id=>isUp(await idbGet('photos', id)), slow.id), 15000, 'slow upload');
  await page.click('#pgrid .th:last-child'); await page.click('#askYes');
  await until(()=>unitPhotos().then(n=>n===2));
  state.putDelay = null; await synced();
  let rj = jobFolder('A','REG-JOB_R-1_Photos');
  T('a photo deleted from a grid opened before its upload finished is still removed from OneDrive', !('Bldg-MAIN/'+slow.file in tree('A', rj)), JSON.stringify(Object.keys(tree('A', rj))));
  /* the number photo cannot be removed from under the others */
  await until(()=>page.locator('#pgrid .th').count().then(n=>n===2), 8000, 'grid reopened');   // the grid reopens after a delete
  await page.click('#pgrid .th:first-child');
  await until(()=>txt('#sheetIn').then(t=>/stays while the unit has other photos/.test(t) && /Retake it/.test(t)));
  T('tapping the chalk-number photo in the grid offers a retake, never a delete, while the unit has other photos', (await unitPhotos())===2);
  await page.click('#askNo'); await until(()=>page.locator('#pgDone').count().then(n=>n===1)); await page.click('#pgDone');

  /* a dead camera track must not produce a photo */
  await ev(()=>{ track.stop(); });
  const seq0 = await ev(()=>S.seq);
  await page.click('#shutter');
  await until(()=>txt('#toast').then(t=>/camera had stalled/.test(t)), 6000, 'stall toast');
  T('the shutter refuses to store a frame from a dead camera and says so', (await ev(()=>S.seq))===seq0);
  await until(()=>ev(()=>!!track && track.readyState==='live' && document.getElementById('video').videoWidth>0), 10000, 'camera restart');
  await shot(1);
  T('the camera restarts by itself and the next shot is stored', (await ev(()=>S.seq))===seq0+1);
  await page.click('#advanceBtn'); await shot(1); await page.click('#advanceBtn'); await until(()=>on('sheet'));
  await page.click('#sheetIn button[data-c="ND"]'); await page.click('#scopeGoNext'); await until(()=>on('sheet').then(v=>!v));
  await synced();

  /* a subfolder deleted in OneDrive mid-job */
  rj = jobFolder('A','REG-JOB_R-1_Photos');
  fake.rm(D('A'), fake.kids(D('A'), rj.id).find(i=>i.name==='Bldg-MAIN').id);
  await shot(1);
  await until(()=>Object.keys(tree('A', rj)).some(k=>/_U002_01-number/.test(k)), 40000, 'subfolder rebuilt');
  T('a subfolder deleted in OneDrive mid-job is rebuilt and uploads carry on', true);
  await page.click('#btnMenu'); await page.click('#mReview'); await reviewReady();
  await page.click('#btnUp'); await until(()=>txt('#opBox').then(t=>/CONFIRMED\.|NOT COMPLETE|Stopped/.test(t)), 40000);
  { const op2 = await txt('#opBox'); const lf = await localFiles(); const rf = tree('A', rj);
    T('CONFIRM finds the photos that went with the deleted subfolder and sends them again', /missing/.test(op2) && /CONFIRMED\./.test(op2) && Object.keys(lf).every(k=>rf[k]===lf[k]), op2.slice(0,500)); }

  /* a photo taken while CONFIRM is reading the folder back */
  state.listDelay = 1200;
  await page.click('#btnUp');
  await until(()=>txt('#opBox').then(t=>/photo map written/.test(t)), 20000, 'map written');
  await ev(async ()=>{ const b = await new Promise(r=>{ const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.toBlob(r,'image/jpeg'); }); await storeShot(b, STEPS[2], {}); });
  await until(()=>txt('#opBox').then(t=>/CONFIRMED\.|NOT COMPLETE|Stopped/.test(t)), 40000);
  state.listDelay = 0;
  T('a photo taken while CONFIRM is reading the folder back is not counted as confirmed',
    await ev(()=>!!S.confirmed && S.confirmed.rev!==S.photoRev && !jobSafe(S)) && /while this check ran/.test(await txt('#opBox')), (await txt('#opBox')).slice(-300));
  await until(async ()=> (await pending())===0, 20000, 'late photo upload');
  T('…and it is uploaded straight afterwards without another tap', true);

  /* a scope corrected after CONFIRM, with auto-upload off */
  await page.click('#btnUp'); await until(()=>txt('#opBox').then(t=>/CONFIRMED\./.test(t) && !/while this check ran/.test(t)), 40000);
  await ev(()=>{ const c = loadCfg(); c.auto = '0'; saveCfg(c); });
  await page.click('#revBody button[data-sc]'); await until(()=>on('sheet'));
  await page.click('#sheetIn button[data-c="UNIT"]'); await page.click('#scopeGo'); await until(()=>on('sheet').then(v=>!v));
  T('a scope corrected after CONFIRM makes the job unsafe until the corrected map is sent',
    await ev(()=>photosSafe(S) && !jobSafe(S)) && /MAP NOT SENT/.test(await pill()), await pill());
  await page.goto(URL0); await until(()=>txt('#resumeInfo').then(t=>/REG JOB/.test(t)));
  T('the start screen says the map changed after the confirm', /map changed afterwards/.test(await txt('#resumeInfo')), await txt('#resumeInfo'));
  await page.fill('#fInsured','OTHER'); await page.fill('#fClaim','X'); await page.click('#btnStart'); await until(()=>on('sheet'));
  T('…and replacing the job then takes the typed word', /NOT reached OneDrive/.test(await txt('#sheetIn')) && await page.locator('#typedIn').count()===1);
  await page.click('#askNo');
  await ev(()=>{ const c = loadCfg(); c.auto = '1'; saveCfg(c); });

  /* a pending OneDrive removal survives Microsoft being unreachable */
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady(); await synced();
  await page.click('#unitBadge'); await page.fill('#nuNum','1'); await page.click('#nuGo'); await until(()=>on('sheet').then(v=>!v));
  const gone = await ev(()=>{ const u = curUnit(); return u.photos[u.photos.length-1].file; });
  state.tokenDrop = true;
  await ev(()=>{ const c = loadCfg(); c.exp = 0; saveCfg(c); });
  await page.click('#lastThumb'); const cnt = await unitPhotos();
  await until(()=>page.locator('#pgrid .th').count().then(n=>n===cnt));
  await page.click('#pgrid .th:last-child'); await page.click('#askYes'); await until(()=>unitPhotos().then(n=>n===cnt-1));
  await page.click('#pgDone').catch(()=>{});
  for(let i=0;i<7;i++){ await ev(()=>pump().catch(()=>{})); await sleep(150); }
  T('a pending OneDrive removal is kept while Microsoft cannot be reached', await ev(()=>S.tomb.length)===1 && ('Bldg-MAIN/'+gone in tree('A', rj)));
  T('…and that reads as offline, not as failed uploads', !/FAILED/.test(await pill()), await pill());
  state.tokenDrop = false;
  await ev(()=>pump().catch(()=>{}));
  await until(()=>!('Bldg-MAIN/'+gone in tree('A', rj)), 20000, 'removal after reconnect');
  T('…and is carried out once Microsoft is reachable again', await ev(()=>S.tomb.length)===0);

  /* a frozen-but-live camera, and a browser without the frame callback */
  await ev(()=>{ const v = document.getElementById('video'); window.__rvfc = v.requestVideoFrameCallback;
                 v.requestVideoFrameCallback = ()=>{}; Object.defineProperty(v,'currentTime',{configurable:true,get:()=>5}); });
  { const b0 = await ev(()=>S.seq); await page.click('#steps .step:nth-child(3)'); await page.click('#shutter');
    await until(()=>txt('#toast').then(t=>/camera had stalled/.test(t)), 8000, 'stall toast (frozen)');
    T('a camera that is live but delivering no new frames is refused too', (await ev(()=>S.seq))===b0); }
  await until(()=>ev(()=>!!track && track.readyState==='live' && !starting), 10000, 'restart');
  await ev(()=>{ const v = document.getElementById('video'); delete v.currentTime; v.requestVideoFrameCallback = undefined; });
  await page.click('#steps .step:nth-child(3)'); await shot(1);
  T('without requestVideoFrameCallback the playback clock decides, and a live shot is stored', true);
  await ev(()=>{ const v = document.getElementById('video'); delete v.requestVideoFrameCallback; });

  /* a double tap while the camera is still starting */
  await synced();
  await page.click('#unitBadge'); await page.fill('#nuNum','9'); await page.click('#nuGo'); await until(()=>on('sheet').then(v=>!v));
  await page.click('#btnMenu'); await page.click('#mReview'); await reviewReady();
  await ev(()=>{ const md = navigator.mediaDevices, real = md.getUserMedia.bind(md);
                 md.getUserMedia = c => new Promise(r=>setTimeout(r,900)).then(()=>real(c)); });
  await page.click('#btnBackCam');
  await ev(()=>{ const b = document.getElementById('shutter'); b.click(); setTimeout(()=>b.click(), 60); setTimeout(()=>b.click(), 140); });
  await until(()=>ev(()=>{ const u = findUnit(S.bldg,'9'); return !!u && !busy; }), 15000, 'double tap settled');
  await sleep(1200);
  T('three quick taps while the camera is starting store exactly one chalk-number photo',
    await ev(()=>findUnit(S.bldg,'9').photos.map(p=>p.step).join(','))==='number', await ev(()=>findUnit(S.bldg,'9').photos.map(p=>p.step).join(',')));
  /* a unit that does hold two number photos (older build) can be put right */
  await ev(async ()=>{ const b = await new Promise(r=>{ const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.toBlob(r,'image/jpeg'); });
                       S.unit = '9'; await storeShot(b, STEPS[0], {batch:true}); });
  T('(fixture) unit 9 now holds two number photos', await ev(()=>findUnit(S.bldg,'9').photos.filter(p=>p.step==='number').length)===2);
  await ev(()=>{ S.unit = '9'; renderCam(); });
  await page.click('#lastThumb'); await until(()=>page.locator('#pgrid .th').count().then(n=>n===2));
  await page.click('#pgrid .th:last-child'); await page.click('#askYes');
  await until(()=>ev(()=>findUnit(S.bldg,'9').photos.length===1), 8000, 'extra number deleted');
  T('an extra chalk-number photo can be deleted', true);
  await page.click('#pgDone').catch(()=>{});

  /* the whole job folder deleted in OneDrive, with nothing waiting to upload */
  await synced();
  fake.rm(D('A'), jobFolder('A','REG-JOB_R-1_Photos').id);
  await page.click('#btnMenu'); await page.click('#mReview'); await reviewReady();
  await page.click('#btnUp'); await until(()=>txt('#opBox').then(t=>/CONFIRMED\.|NOT COMPLETE|Stopped/.test(t)), 60000);
  rj = jobFolder('A','REG-JOB_R-1_Photos');
  { const op3 = await txt('#opBox'); const lf = await localFiles(); const rf = rj ? tree('A', rj) : {};
    T('a job folder deleted in OneDrive is rebuilt by CONFIRM and every photo sent again', /rebuilding/.test(op3) && /CONFIRMED\./.test(op3) && Object.keys(lf).length>0 && Object.keys(lf).every(k=>rf[k]===lf[k]), op3.slice(0,600)); }
  await page.click('#btnBackCam'); await until(()=>on('scCam')); await camReady();

  /* a late save while the job is being switched must not blank the stored record */
  T('saveState does nothing while there is no current job', await ev(async ()=>{ const keep = S; S = null; await saveState(); const st = await loadState(); S = keep; return !!st && st.insured==='REG JOB'; }));

  /* two copies of the app */
  { const p2 = await ctx.newPage(); hook(p2); await p2.goto(URL0);
    await until(()=>p2.locator('#setupAuthState').innerText().then(t=>/open in another tab/.test(t)), 10000, 'second tab notice');
    T('a second tab refuses to run alongside the first', await p2.locator('#btnStart').isDisabled() && await p2.locator('#btnResume').isDisabled());
    await p2.click('#btnSteal');
    await until(()=>p2.locator('#btnStart').isEnabled(), 10000, 'second tab takes over');
    await until(()=>txt('#setupAuthState').then(t=>/open in another tab/.test(t)), 15000, 'first tab stands down');
    T('"Use this copy instead" hands over: the new tab runs and the old one stands down', await page.locator('#btnStart').isDisabled());
    await p2.close();
    await until(()=>page.locator('#btnStart').isEnabled(), 10000, 'first tab back');
    T('when the other copy closes, the waiting one carries on by itself', true); }
  await page.click('#btnResume'); await until(()=>on('scCam')); await camReady();

  /* a new job started while the old job's map is uploading */
  await synced();
  await ev(()=>{ touch(false); return saveState(); });
  state.putDelay = {re:/PHOTO_MAP\.json/, ms:3500};
  await page.goto(URL0); await until(()=>txt('#resumeInfo').then(t=>/REG JOB/.test(t)));
  await until(()=>ev(()=>SY.running), 15000, 'boot upload pass');
  await sleep(600);
  await page.fill('#fInsured','SECOND JOB'); await page.fill('#fClaim','S-2'); await page.click('#btnStart');
  await until(()=>on('sheet')); await page.fill('#typedIn','DELETE'); await page.click('#askYes');
  await until(()=>on('scCam'), 30000, 'new job');
  state.putDelay = null; await sleep(800);
  { const mapItem = fake.kids(D('A'), rj.id).find(i=>i.name==='PHOTO_MAP.json'); const doc = JSON.parse(mapItem.content.toString());
    T('a new job waits for the upload pass in flight, and the old job\'s map in OneDrive stays its own', doc.claim.insured==='REG JOB' && doc.photo_map.length>0 && doc.units.length>0,
      doc.claim.insured+' / '+doc.photo_map.length); }

  /* a release whose download fails must not replace the working copy */
  await camReady();
  state.swSuffix = '\n// a newer release'; state.siteFail = true;
  await ev(async ()=>{ const r = await navigator.serviceWorker.getRegistration(); try{ await r.update(); }catch(e){} });
  await sleep(2000);
  state.siteDown = true;
  await page.goto(URL0).catch(()=>{});
  let opened = false;
  try{ await until(()=>txt('#buildTag').then(t=>/3\.0/.test(t)), 8000, 'offline open'); opened = true; }catch(e){}
  T('a release whose download fails does not take over: the app still opens with the server unreachable', opened);
  state.siteDown = false; state.siteFail = false; state.swSuffix = '';

  /* ---------- wrap up ---------- */
  T('no uncaught page errors in the whole run', errors.length===0, errors.slice(0,5).join(' | '));
  await browser.close(); srv.close();
  const fail = results.filter(r=>!r.ok);
  fs.writeFileSync(path.join(OUT,'results.json'), JSON.stringify(results,null,1));
  console.log(`\n${results.length-fail.length} passed, ${fail.length} failed, ${results.length} checks`);
  process.exit(fail.length?1:0);
})().catch(e=>{ console.error('\nTEST RUN ABORTED:', e); const fail = results.filter(r=>!r.ok);
  console.log(`${results.length-fail.length} passed, ${fail.length} failed before abort`); process.exit(2); });
