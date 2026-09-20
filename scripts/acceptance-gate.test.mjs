import assert from 'node:assert/strict';
import {randomBytes,scryptSync} from 'node:crypto';
import {once} from 'node:events';
import test from 'node:test';
import {createEntryServer} from './acceptance-gate.mjs';

test('入口会话不使用 HTTP Basic，保留认证、CSRF、过期、退出与限流',async()=>{
  let now=Date.now();const password='A9!'+randomBytes(24).toString('hex');const salt=randomBytes(16).toString('hex');
  const server=createEntryServer({username:'acceptance',passwordSalt:salt,passwordHash:scryptSync(password,salt,64).toString('hex'),csrfKey:randomBytes(32).toString('hex'),origins:['https://accept.example.test']},()=>now);
  server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const call=(path,options={})=>fetch(url+path,{redirect:'manual',...options});
  const cookies=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).filter(value=>!value.endsWith('=')).join('; ');
  async function form(){const response=await call('/_entry/login');assert.equal(response.status,200);assert.equal(response.headers.get('www-authenticate'),null);assert.equal(response.headers.get('cache-control'),'no-store');const html=await response.text();return {cookie:cookies(response),csrf:html.match(/name="csrf" value="([^"]+)"/)[1]};}
  const submit=(fields,initial,origin='https://accept.example.test',path='/_entry/login')=>call(path,{method:'POST',headers:{Origin:origin,Cookie:initial.cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:initial.csrf,username:'acceptance',password,...fields})});
  try{
    assert.equal((await call('/_entry/check')).status,401);
    assert.equal((await call('/_entry/check',{headers:{Cookie:'__Host-sampleflow_entry=fake'}})).status,401);
    const navigation=await call('/_entry/required',{headers:{accept:'text/html','x-entry-original-uri':'//evil.invalid'}});assert.equal(navigation.status,303);assert.equal(navigation.headers.get('location'),'/_entry/login?returnTo=%2F');
    const denied=await call('/_entry/required');assert.equal(denied.status,401);assert.equal(denied.headers.get('www-authenticate'),null);
    assert.equal((await call('/_entry/login')).headers.get('referrer-policy'),'same-origin');
    const initial=await form();
    assert.equal((await submit({},initial,'https://evil.invalid')).status,403);
    assert.equal((await submit({csrf:'wrong'},initial)).status,403);
    const wrong=await submit({password:'wrong'},initial);assert.equal(wrong.status,403);assert.equal(wrong.headers.get('www-authenticate'),null);
    const login=await submit({returnTo:'/?page=orders'},initial);assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/?page=orders');
    assert.ok(login.headers.getSetCookie().every(value=>/HttpOnly; Secure; SameSite=Strict/.test(value)));
    const session=cookies(login);assert.equal((await call('/_entry/check',{headers:{Cookie:session}})).status,204);
    // 业务 401 不修改入口会话；验证只依赖入口 Cookie。
    for(let index=0;index<3;index++)assert.equal((await call('/_entry/check',{headers:{Cookie:session,Authorization:'Basic stale'}})).status,204);
    now+=8*60*60*1000;assert.equal((await call('/_entry/check',{headers:{Cookie:session}})).status,401);
    const fresh=await form();const next=await submit({returnTo:'//evil.invalid'},fresh);assert.equal(next.headers.get('location'),'/');
    const signedIn=cookies(next);const logoutForm=await form();
    assert.equal((await submit({}, {csrf:logoutForm.csrf,cookie:signedIn+'; '+logoutForm.cookie},'https://accept.example.test','/_entry/logout')).status,303);
    assert.equal((await call('/_entry/check',{headers:{Cookie:signedIn}})).status,401);
    now+=60001;const limited=await form();let last;
    for(let index=0;index<31;index++)last=await submit({password:'wrong'},limited);
    assert.equal(last.status,429);assert.ok(last.headers.get('retry-after'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
