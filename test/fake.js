/* A fake Microsoft sign-in + OneDrive (Graph) + the app's own site, on one local
   HTTPS server. Chromium is pointed at it for the real host names, so the app
   under test runs unmodified: real fetches, real CORS preflights, real bodies. */
const https = require('https'), fs = require('fs'), path = require('path');

const SITE_HOST = 'jasontjames02.github.io';
const BASE = 'Documents/Claude/Projects/Assessment reports';

function mkDrive(id, upn, withBase){
  const d = {id, upn, items:new Map(), seq:1};
  d.root = add(d, null, 'root', true);
  if(withBase){
    let p = d.root;
    for(const seg of BASE.split('/')) p = add(d, p.id, seg, true);
    d.base = p;
    add(d, p.id, 'ABOUNDING LIFE COGIC AA208306', true);
    add(d, p.id, 'CLEVELAND ZURICH CLAIM', true);
    add(d, p.id, 'GTP_STANDARD.md', false, Buffer.from('x'));
  }
  return d;
}
function add(d, parentId, name, folder, content){
  const id = d.id+'!'+(d.seq++);
  const it = {id, name, parentId, folder:!!folder, content:folder?null:(content||Buffer.alloc(0)),
              mtime:new Date(Date.now()+d.seq).toISOString()};
  d.items.set(id, it);
  return it;
}
const kids = (d, id) => [...d.items.values()].filter(i=>i.parentId===id);
function byPath(d, parent, p){
  let cur = parent;
  for(const seg of p.split('/').filter(Boolean)){
    cur = kids(d, cur.id).find(i=>i.name.toLowerCase()===seg.toLowerCase());
    if(!cur) return null;
  }
  return cur;
}
function rm(d, id){ for(const k of kids(d,id)) rm(d,k.id); d.items.delete(id); }
function view(d, it){
  const o = {id:it.id, name:it.name, lastModifiedDateTime:it.mtime,
             webUrl:'https://onedrive.live.com/?id='+encodeURIComponent(it.id)};
  if(it.folder) o.folder = {childCount:kids(d,it.id).length}; else { o.file = {}; }
  o.size = it.folder ? 0 : it.content.length;
  return o;
}

const state = {
  drives:{}, accounts:{},          // account key -> drive
  nextAccount:'A',                 // who the next interactive sign-in is
  tokens:new Map(),                // access token -> account key
  refresh:new Map(),               // refresh token -> account key
  refreshFails:false,              // invalid_grant on refresh
  expireAccess:false,              // next Graph call returns 401 once
  throttle:0,                      // next N Graph writes return 429
  truncateNext:0,                  // next N uploads are stored short (corruption)
  dropNextPut:0,                   // next N uploads report OK but store nothing
  log:[], sessions:new Map(), tokSeq:1, authorizeHits:[],
};
function reset(){
  state.drives = {
    A: mkDrive('DRIVE_A','jasontjames1974@gmail.com', true),
    B: mkDrive('DRIVE_B','other.account@outlook.com', true),
    C: mkDrive('DRIVE_C','no.folder@outlook.com', false),
  };
  state.nextAccount = 'A'; state.tokens.clear(); state.refresh.clear();
  state.refreshFails = false; state.expireAccess = false; state.throttle = 0;
  state.truncateNext = 0; state.dropNextPut = 0; state.log = []; state.authorizeHits = [];
  state.tokenDelay = 0; state.tokenDrop = false; state.putDelay = null; state.listDelay = 0;
  state.siteFail = false; state.siteDown = false; state.swSuffix = ''; state.pageSize = 0;
}
const wait = ms => new Promise(r=>setTimeout(r,ms));
reset();

const CORS = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers':'Authorization,Content-Type,Content-Range','Access-Control-Expose-Headers':'Retry-After',
  'Access-Control-Max-Age':'600'};
const json = (res, code, obj, extra) => { const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({'Content-Type':'application/json','Content-Length':b.length}, CORS, extra||{})); res.end(b); };
const gerr = (res, code, c, m, extra) => json(res, code, {error:{code:c, message:m||c}}, extra);
const body = req => new Promise(r=>{ const ch=[]; req.on('data',c=>ch.push(c)); req.on('end',()=>r(Buffer.concat(ch))); });

function issue(acct){
  const at = 'AT-'+acct+'-'+(state.tokSeq++), rt = 'RT-'+acct+'-'+(state.tokSeq++);
  state.tokens.set(at, acct); state.refresh.set(rt, acct);
  return {token_type:'Bearer', expires_in:3600, access_token:at, refresh_token:rt, scope:'Files.ReadWrite'};
}

async function login(req, res, u){
  if(/\/authorize$/.test(u.pathname)){
    state.authorizeHits.push(Object.assign(Object.fromEntries(u.searchParams), {_path:u.pathname}));
    const to = new URL(u.searchParams.get('redirect_uri'));
    to.searchParams.set('code', 'CODE-'+state.nextAccount);
    to.searchParams.set('state', u.searchParams.get('state')||'');
    res.writeHead(302, {Location:to.toString()}); return res.end();
  }
  if(/\/logout$/.test(u.pathname)){
    res.writeHead(302, {Location:u.searchParams.get('post_logout_redirect_uri')}); return res.end();
  }
  if(/\/token$/.test(u.pathname)){
    const p = new URLSearchParams((await body(req)).toString());
    if(state.tokenDrop){ req.socket.destroy(); return; }
    if(state.tokenDelay) await wait(state.tokenDelay);
    if(p.get('grant_type')==='authorization_code'){
      const acct = (p.get('code')||'').replace('CODE-','');
      if(!state.drives[acct] || !p.get('code_verifier')) return json(res, 400, {error:'invalid_grant', error_description:'AADSTS70000 bad code'});
      return json(res, 200, issue(acct));
    }
    if(p.get('grant_type')==='refresh_token'){
      const acct = state.refresh.get(p.get('refresh_token'));
      if(state.refreshFails || !acct) return json(res, 400, {error:'invalid_grant', error_description:'AADSTS700084: The refresh token was issued to a single page app (SPA), and therefore has a fixed, limited lifetime of 1.00:00:00, which cannot be extended.'});
      return json(res, 200, issue(acct));
    }
  }
  res.writeHead(404, CORS); res.end();
}

async function graph(req, res, u){
  const auth = (req.headers.authorization||'').replace(/^Bearer /,'');
  const acct = state.tokens.get(auth);
  const p = decodeURIComponent(u.pathname.replace(/^\/v1\.0/,''));
  state.log.push(req.method+' '+p);
  if(state.expireAccess){ state.expireAccess = false; state.tokens.delete(auth); return gerr(res, 401, 'InvalidAuthenticationToken', 'Access token has expired.'); }
  if(!acct) return gerr(res, 401, 'InvalidAuthenticationToken', 'Access token is empty or invalid.');
  const mine = state.drives[acct];
  if(req.method!=='GET' && state.throttle>0){ state.throttle--; await body(req); return gerr(res, 429, 'activityLimitReached', 'throttled', {'Retry-After':'1'}); }

  if(p==='/me') return json(res, 200, {userPrincipalName:mine.upn, displayName:'Jason James'});
  if(p==='/me/drive') return json(res, 200, {id:mine.id, driveType:'personal', owner:{user:{displayName:'Jason James', email:mine.upn}}});

  let m = /^\/drives\/([^/]+)\/(.*)$/.exec(p);
  if(!m) return gerr(res, 400, 'BadRequest', 'unsupported in fake: '+p);
  const d = Object.values(state.drives).find(x=>x.id===m[1]);
  /* Another account's drive is simply not reachable with this token. */
  if(!d || d!==mine){ await body(req); return gerr(res, 403, 'accessDenied', 'Access denied'); }
  const rest = m[2];

  // /root:/path
  m = /^root:\/(.+?)$/.exec(rest);
  if(m && req.method==='GET'){
    const it = byPath(d, d.root, m[1]);
    return it ? json(res, 200, view(d,it)) : gerr(res, 404, 'itemNotFound', 'The resource could not be found.');
  }
  // /items/{id}:/{name}:/content | :/createUploadSession | (get by relative path)
  m = /^items\/([^/:]+):\/(.+?)(?::\/(content|createUploadSession))?$/.exec(rest);
  if(m){
    const parent = d.items.get(m[1]);
    if(!parent) { await body(req); return gerr(res, 404, 'itemNotFound'); }
    const name = m[2], act = m[3];
    const ex = kids(d, parent.id).find(i=>i.name.toLowerCase()===name.toLowerCase());
    if(!act && req.method==='GET') return ex ? json(res, 200, view(d,ex)) : gerr(res, 404, 'itemNotFound');
    if(act==='content' && req.method==='PUT'){
      let buf = await body(req);
      if(state.putDelay && state.putDelay.re.test(name)) await wait(state.putDelay.ms);
      if(buf.length >= 4*1024*1024) return gerr(res, 413, 'requestEntityTooLarge', 'simple upload is limited to 4 MB');
      if(state.dropNextPut>0){ state.dropNextPut--; return json(res, 201, {id:d.id+'!ghost', name, size:buf.length}); }
      if(state.truncateNext>0){ state.truncateNext--; buf = buf.subarray(0, Math.max(1, buf.length-10)); }
      let it = ex; if(it) it.content = buf; else it = add(d, parent.id, name, false, buf);
      return json(res, ex?200:201, view(d,it));
    }
    if(act==='createUploadSession' && req.method==='POST'){
      await body(req);
      const sid = 'S'+(state.tokSeq++);
      state.sessions.set(sid, {d, parentId:parent.id, name, parts:[]});
      return json(res, 200, {uploadUrl:'https://upload.fake.test/session/'+sid});
    }
  }
  // /items/{id}/children
  m = /^items\/([^/:]+)\/children$/.exec(rest);
  if(m){
    const parent = d.items.get(m[1]);
    if(!parent){ await body(req); return gerr(res, 404, 'itemNotFound'); }
    if(req.method==='GET'){
      if(state.listDelay) await wait(state.listDelay);
      let list = kids(d, parent.id).map(i=>view(d,i));
      if(/desc/.test(u.searchParams.get('$orderby')||'')) list.sort((a,b)=>b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime));
      const top = +(u.searchParams.get('$top')||200), skip = +(u.searchParams.get('$skip')||0);
      const size = Math.min(top, state.pageSize||top);
      const page = list.slice(skip, skip+size);
      const o = {value:page};
      if(skip+page.length < list.length){
        const nx = new URL(u.toString()); nx.searchParams.set('$skip', String(skip+page.length));
        o['@odata.nextLink'] = nx.toString();
      }
      return json(res, 200, o);
    }
    if(req.method==='POST'){
      const b = JSON.parse((await body(req)).toString());
      if(kids(d, parent.id).some(i=>i.name.toLowerCase()===b.name.toLowerCase()))
        return gerr(res, 409, 'nameAlreadyExists', 'An item with the same name already exists under the parent');
      return json(res, 201, view(d, add(d, parent.id, b.name, true)));
    }
  }
  // /items/{id}
  m = /^items\/([^/:]+)$/.exec(rest);
  if(m){
    const it = d.items.get(m[1]);
    if(!it) return gerr(res, 404, 'itemNotFound');
    if(req.method==='GET'){
      const o = view(d,it);
      if(!it.folder) o['@microsoft.graph.downloadUrl'] = 'https://download.fake.test/'+encodeURIComponent(it.id);
      return json(res, 200, o);
    }
    if(req.method==='DELETE'){ rm(d, it.id); res.writeHead(204, CORS); return res.end(); }
  }
  await body(req);
  return gerr(res, 400, 'BadRequest', 'unsupported in fake: '+req.method+' '+p);
}

async function upload(req, res, u){
  const s = state.sessions.get(u.pathname.split('/').pop());
  if(!s){ res.writeHead(404, CORS); return res.end(); }
  const buf = await body(req);
  const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers['content-range']||'');
  s.parts.push(buf);
  if(+m[2]+1 < +m[3]) return json(res, 202, {nextExpectedRanges:[(+m[2]+1)+'-']});
  let all = Buffer.concat(s.parts);
  if(state.truncateNext>0){ state.truncateNext--; all = all.subarray(0, all.length-10); }
  const ex = kids(s.d, s.parentId).find(i=>i.name.toLowerCase()===s.name.toLowerCase());
  let it = ex; if(it) it.content = all; else it = add(s.d, s.parentId, s.name, false, all);
  return json(res, 201, view(s.d, it));
}
function download(req, res, u){
  const id = decodeURIComponent(u.pathname.slice(1));
  for(const d of Object.values(state.drives)){
    const it = d.items.get(id);
    if(it){ res.writeHead(200, Object.assign({'Content-Type':'application/octet-stream'}, CORS)); return res.end(it.content); }
  }
  res.writeHead(404, CORS); res.end();
}
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.png':'image/png','.webmanifest':'application/manifest+json'};
function site(req, res, u, dir){
  let p = u.pathname;
  if(state.siteDown){ req.socket.destroy(); return; }
  if(!p.startsWith('/field-cam/')){ res.writeHead(404); return res.end(); }
  p = p.slice('/field-cam/'.length) || 'index.html';
  if(state.siteFail && p!=='sw.js'){ res.writeHead(503); return res.end('unavailable'); }
  const f = path.join(dir, p);
  if(!f.startsWith(dir) || !fs.existsSync(f)){ res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, {'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','Cache-Control':'no-cache'});
  let data = fs.readFileSync(f);
  if(p==='sw.js' && state.swSuffix) data = Buffer.concat([data, Buffer.from(state.swSuffix)]);
  res.end(data);
}

function start(dir, port){
  const srv = https.createServer({key:fs.readFileSync(path.join(__dirname,'key.pem')), cert:fs.readFileSync(path.join(__dirname,'cert.pem'))},
    async (req, res)=>{
      try{
        const host = (req.headers.host||'').split(':')[0];
        const u = new URL(req.url, 'https://'+host);
        if(req.method==='OPTIONS'){ res.writeHead(204, CORS); return res.end(); }
        if(host==='login.microsoftonline.com') return await login(req, res, u);
        if(host==='graph.microsoft.com')       return await graph(req, res, u);
        if(host==='upload.fake.test')          return await upload(req, res, u);
        if(host==='download.fake.test')        return download(req, res, u);
        if(host===SITE_HOST)                   return site(req, res, u, state.siteDir || dir);
        res.writeHead(404); res.end();
      }catch(e){ console.error('FAKE SERVER ERROR', e); try{ res.writeHead(500, CORS); res.end(String(e)); }catch(_){} }
    });
  return new Promise(r=>srv.listen(port, '127.0.0.1', ()=>r(srv)));
}
/* Write a OneDrive folder out to disk so the real verifier can read it. */
function dump(d, it, dest){
  fs.mkdirSync(dest, {recursive:true});
  for(const k of kids(d, it.id)){
    if(k.folder) dump(d, k, path.join(dest, k.name));
    else fs.writeFileSync(path.join(dest, k.name), k.content);
  }
}
module.exports = {state, reset, start, kids, byPath, add, rm, dump, BASE, SITE_HOST};
