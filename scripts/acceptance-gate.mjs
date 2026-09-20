import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const derive = promisify(scrypt);
const SESSION = '__Host-sampleflow_entry';
const CSRF = '__Host-sampleflow_entry_csrf';
const lifetime = 8 * 60 * 60 * 1000;
const styles = 'body{margin:0;background:#f4f7fb;color:#172b46;font:16px/1.6 system-ui,sans-serif}main{box-sizing:border-box;max-width:440px;margin:8vh auto;padding:32px;background:white;border:1px solid #dce4ef;border-radius:16px}h1{font-size:26px;margin:4px 0 12px}p{color:#52647e}label{display:block;margin:16px 0 6px}input,button{box-sizing:border-box;width:100%;font:inherit;min-height:46px;border-radius:6px}input{border:1px solid #8796ac;padding:8px 12px}button{margin-top:24px;border:0;background:#245bd3;color:white;cursor:pointer}a{color:#245bd3}small{display:block;margin-top:18px;color:#52647e}:focus-visible{outline:3px solid #75a3ff;outline-offset:3px}.error{color:#ae1724}@media(max-width:480px){main{margin:24px 16px;padding:24px}}';
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const safePath = value => typeof value === 'string' && value.startsWith('/') && !/^\/[/\\]|[\r\n\\]/.test(value) && !value.startsWith('/_entry/') && value.length < 2048 ? value : '/';
const digest = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(Buffer.from(digest(left)),Buffer.from(digest(right)));
const cookie = (name,value,seconds) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
function readCookie(request,name) {
  const values = (request.headers.cookie??'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
  return values.length === 1 ? values[0].slice(name.length+1) : '';
}

export function entryNginx(source) {
  if(source.split('server_name _;').length!==2)throw new Error('Nginx 模板已变化，需要核对入口位置');
  const locations=`server_name _;
  auth_request /_entry/check;
  error_page 401 = /_entry/required;

  location = /_entry/check {
    internal;
    auth_request off;
    proxy_pass http://acceptance-gate:8081;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Authorization "";
  }
  location = /_entry/required {
    internal;
    auth_request off;
    proxy_pass http://acceptance-gate:8081;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Entry-Original-URI $request_uri;
    proxy_set_header Authorization "";
  }
  location /_entry/ {
    auth_request off;
    client_max_body_size 4k;
    proxy_pass http://acceptance-gate:8081;
    proxy_set_header Authorization "";
    # 入口页自行提供 CSP，避免与业务页面 CSP 的样式规则冲突。
    add_header Cache-Control "no-store" always;
  }`;
  return source.replace('server_name _;',locations).replace('proxy_pass http://api:3000;','proxy_pass http://api:3000;\n    proxy_set_header Authorization "";').replace('location = /healthz {','location = /healthz {\n    auth_request off;');
}

export async function checkEntry(origin,credentials,allowedOrigin=origin) {
  const request=(path,options={})=>fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(20000),...options});
  const requireStatus=(response,status)=>{if(response.status!==status||response.headers.has('www-authenticate'))throw new Error(`入口检查失败：预期 ${status}，实际 ${response.status}`);};
  for(const path of ['/','/api/ready','/maps/china-provinces.geojson']) requireStatus(await request(path),401);
  const response=await request('/_entry/login');requireStatus(response,200);
  const html=await response.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];if(!csrf)throw new Error('入口表单缺少安全令牌');
  const cookieHeader=result=>result.headers.getSetCookie().map(value=>value.split(';')[0]).filter(value=>!value.endsWith('=')).join('; ');
  const formCookie=cookieHeader(response);
  const login=password=>request('/_entry/login',{method:'POST',headers:{Origin:allowedOrigin,Cookie:formCookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:credentials.entryUsername,password,csrf,returnTo:'/'})});
  requireStatus(await login('invalid-password'),403);
  const signedIn=await login(credentials.entryPassword);requireStatus(signedIn,303);const session=cookieHeader(signedIn);
  if(!signedIn.headers.getSetCookie().every(value=>/HttpOnly; Secure; SameSite=Strict/.test(value)))throw new Error('入口 Cookie 缺少安全属性');
  try {
    for(const path of ['/','/api/ready']) requireStatus(await request(path,{headers:{Cookie:session}}),200);
    requireStatus(await request('/api/auth/me',{headers:{Cookie:session}}),401);
    requireStatus(await request('/api/ready',{headers:{Cookie:session}}),200);
  } finally {
    const form=await request('/_entry/logout');const body=await form.text();const token=body.match(/name="csrf" value="([^"]+)"/)?.[1];
    const logout=await request('/_entry/logout',{method:'POST',headers:{Origin:allowedOrigin,Cookie:session+'; '+cookieHeader(form),'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token??''})});requireStatus(logout,303);
  }
  requireStatus(await request('/api/ready',{headers:{Cookie:session}}),401);
}

export function createEntryServer(config, now = Date.now) {
  if (!config.username || !/^[a-f0-9]{128}$/.test(config.passwordHash) || !/^[a-f0-9]{32}$/.test(config.passwordSalt) || !/^[a-f0-9]{64}$/.test(config.csrfKey) || !Array.isArray(config.origins) || !config.origins.length) throw new Error('入口配置无效');
  const sessions = new Map();
  let attempts = 0; let windowEnd = 0;
  const signature = value => createHmac('sha256',config.csrfKey).update(value).digest('hex');
  function csrfToken() {const value=`${now()+600000}.${randomBytes(24).toString('hex')}`;return `${value}.${signature(value)}`;}
  function validCsrf(token) {
    if(typeof token!=='string'||token.length>160)return false;
    const [expiry,nonce,mac,...extra]=token.split('.');
    return !extra.length && /^\d{13}$/.test(expiry??'') && /^[a-f0-9]{48}$/.test(nonce??'') && Number(expiry)>now() && Number(expiry)<=now()+600000 && same(mac,signature(`${expiry}.${nonce}`));
  }
  function session(request) {
    const token=readCookie(request,SESSION);if(!/^[a-f0-9]{64}$/.test(token))return null;
    const key=digest(token);const expires=sessions.get(key);
    if(!expires||expires<=now()){sessions.delete(key);return null;}return key;
  }
  function page(response,{error='',returnTo='/',logout=false,status=200}={}) {
    const token=csrfToken();response.setHeader('Set-Cookie',cookie(CSRF,token,600));
    response.writeHead(status,{'content-type':'text/html; charset=utf-8'});
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${logout?'退出公网入口':'公网入口验证'} — SampleFlow</title><style>${styles}</style><main><small>SampleFlow · 客户试用</small><h1>${logout?'退出公网入口':'公网入口验证'}</h1><p>${logout?'退出后此浏览器需要重新验证入口密码，并重新登录系统账号。':'请先输入交付方提供的入口账号和密码，再登录你的系统账号。'}</p>${error?`<p role="alert" class="error">${escape(error)}</p>`:''}<form method="post" action="/_entry/${logout?'logout':'login'}"><input type="hidden" name="csrf" value="${token}"><input type="hidden" name="returnTo" value="${escape(safePath(returnTo))}">${logout?'':'<label for="username">入口用户名</label><input id="username" name="username" autocomplete="username" required maxlength="100" autofocus><label for="password">入口密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128">'}<button type="submit">${logout?'退出公网入口':'验证并进入系统'}</button></form><small>${logout?'<a href="/">返回系统</a>':'验证有效期为 8 小时；有效期内无需反复输入。到期后刷新页面重新验证。<br>这里不是 trial-… 系统账号的登录页。'}</small></main></html>`);
  }
  const server=createServer(async(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    // 原生表单需要保留同源 Origin；no-referrer 会让浏览器发送 Origin: null。
    response.setHeader('Referrer-Policy','same-origin');
    response.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    const path=new URL(request.url,'http://entry.invalid').pathname;
    const json=(status,message)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({message,code:'ENTRY_AUTH_REQUIRED'}));};
    try {
      if(path==='/_entry/health'){response.writeHead(204);return response.end();}
      if(path==='/_entry/check'){response.writeHead(session(request)?204:401);return response.end();}
      if(path==='/_entry/required'){
        if(request.headers['sec-fetch-dest']==='document'||request.headers.accept?.includes('text/html')){
          response.writeHead(303,{Location:'/_entry/login?returnTo='+encodeURIComponent(safePath(request.headers['x-entry-original-uri']))});return response.end();
        }
        return json(401,'公网入口验证已过期，请刷新页面后重新验证入口密码。');
      }
      const logout=path==='/_entry/logout';
      if(!logout&&path!=='/_entry/login')return json(404,'页面不存在');
      if(request.method==='GET')return page(response,{logout,returnTo:new URL(request.url,'http://entry.invalid').searchParams.get('returnTo')??'/'});
      if(request.method!=='POST')return json(405,'请求方法不支持');
      if(!config.origins.includes(request.headers.origin))return json(403,'请求来源无效，请重新打开入口页面。');
      if(request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return json(415,'表单格式无效');
      let body='';
      for await(const chunk of request){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>4096)return json(413,'表单过大');}
      const form=new URLSearchParams(body);const csrf=form.get('csrf');
      if(!validCsrf(csrf)||!same(csrf,readCookie(request,CSRF)))return page(response,{status:403,error:'验证页面已过期，请重新输入入口账号和密码。'});
      if(logout){
        const key=session(request);if(key)sessions.delete(key);
        response.setHeader('Set-Cookie',[cookie(SESSION,'',0),cookie(CSRF,'',0),cookie('sampleflow_session','',0),cookie('sampleflow_csrf','',0)]);
        response.writeHead(303,{Location:'/_entry/login'});return response.end();
      }
      // ponytail: 独立试用入口共用每分钟 30 次验证预算；更大规模再换按可信客户端限流的网关。
      if(now()>=windowEnd){attempts=0;windowEnd=now()+60000;}
      if(attempts>=30){response.setHeader('Retry-After',String(Math.max(1,Math.ceil((windowEnd-now())/1000))));return page(response,{status:429,error:'验证请求较多，请一分钟后重试。'});}attempts++;
      const username=form.get('username')??'';const password=form.get('password')??'';
      if(username.length>100||!password||password.length>128)return page(response,{status:400,error:'请填写有效的入口账号和密码。'});
      const hash=await derive(password,config.passwordSalt,64);
      if(!same(username,config.username)||!timingSafeEqual(hash,Buffer.from(config.passwordHash,'hex')))return page(response,{status:403,error:'入口账号或密码不正确，请核对后重试。',returnTo:form.get('returnTo')});
      for(const [key,expires] of sessions)if(expires<=now())sessions.delete(key);
      if(sessions.size>=512)return page(response,{status:503,error:'入口会话已满，请稍后重试。'});
      const previous=session(request);if(previous)sessions.delete(previous);
      const token=randomBytes(32).toString('hex');sessions.set(digest(token),now()+lifetime);
      response.setHeader('Set-Cookie',[cookie(SESSION,token,lifetime/1000),cookie(CSRF,'',0)]);
      response.writeHead(303,{Location:safePath(form.get('returnTo'))});response.end();
    } catch {if(!response.headersSent)json(500,'入口暂时不可用，请稍后重试。');else response.end();}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxHeadersCount=40;
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createEntryServer(JSON.parse(readFileSync(process.env.ENTRY_CONFIG_FILE??'/run/entry/config.json','utf8')));
  server.listen(8081,'0.0.0.0',()=>console.log('验收入口会话服务已启动。'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close());
}
