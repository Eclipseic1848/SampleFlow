import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,scryptSync} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {checkEntry,entryNginx} from './acceptance-gate.mjs';

test('真实 Nginx 保留业务 401，入口会话不会产生 Basic challenge',async()=>{
  const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe']}).trim();
  assert.ok(!process.env.DOCKER_HOST);assert.match(docker(['context','inspect','--format','{{.Endpoints.docker.Host}}']),/^npipe:\/\//);
  const root=fileURLToPath(new URL('../',import.meta.url));
  const directory=mkdtempSync(join(tmpdir(),'sampleflow-entry-check-'));const prefix='sampleflow-entry-check-'+randomBytes(5).toString('hex');
  const password=randomBytes(24).toString('hex');const salt=randomBytes(16).toString('hex');const origin='http://127.0.0.1:18080';
  const created=[];let network=false;
  try{
    writeFileSync(join(directory,'config.json'),JSON.stringify({username:'acceptance',passwordHash:scryptSync(password,salt,64).toString('hex'),passwordSalt:salt,csrfKey:randomBytes(32).toString('hex'),origins:[origin]}),'utf8');
    writeFileSync(join(directory,'nginx.conf'),entryNginx(readFileSync(join(root,'apps/web/nginx.conf'),'utf8')),'utf8');
    // 只连接合成 API，不连接试用库或开发库。
    writeFileSync(join(directory,'runtime.mjs'),`import {readFileSync} from 'node:fs';import {createServer} from 'node:http';import {createEntryServer} from '/entry/acceptance-gate.mjs';createEntryServer(JSON.parse(readFileSync('/fixture/config.json','utf8'))).listen(8081,'0.0.0.0');createServer((request,response)=>{response.writeHead(request.url==='/api/auth/me'?401:200,{'content-type':'application/json'});response.end('{}');}).listen(3000,'0.0.0.0');`,'utf8');
    docker(['network','create',prefix]);network=true;
    docker(['run','-d','--name',prefix+'-gate','--network',prefix,'--network-alias','acceptance-gate','--network-alias','api','--read-only','--user','node','--mount',`type=bind,source=${directory},target=/fixture,readonly`,'--mount',`type=bind,source=${join(root,'scripts')},target=/entry,readonly`,'sampleflow-acceptance-api','node','/fixture/runtime.mjs']);created.push(prefix+'-gate');
    docker(['run','-d','--name',prefix+'-web','--network',prefix,'-p','127.0.0.1::8080','--mount',`type=bind,source=${join(directory,'nginx.conf')},target=/etc/nginx/conf.d/default.conf,readonly`,'sampleflow-acceptance-web']);created.push(prefix+'-web');
    const port=JSON.parse(docker(['inspect',prefix+'-web']))[0].NetworkSettings.Ports['8080/tcp'][0].HostPort;
    const address=`http://127.0.0.1:${port}`;
    for(let attempt=0;attempt<30;attempt++){try{if((await fetch(address+'/healthz')).ok)break;}catch{}await new Promise(done=>setTimeout(done,200));}
    await checkEntry(address,{entryUsername:'acceptance',entryPassword:password},origin);
    const redirect=await fetch(address+'/?page=orders',{headers:{Accept:'text/html'},redirect:'manual'});
    assert.equal(redirect.status,303);assert.equal(redirect.headers.get('location'),'/_entry/login?returnTo=%2F%3Fpage%3Dorders');
    assert.equal((await fetch(address+'/_entry/check')).status,404);
    assert.equal((await fetch(address+'/api/ready',{headers:{Authorization:'Basic '+Buffer.from('acceptance:'+password).toString('base64')}})).status,401);
    docker(['stop',prefix+'-gate']);
    assert.equal((await fetch(address+'/api/ready')).status,500,'入口服务故障必须拒绝放行');
  }finally{
    for(const name of created.reverse())docker(['rm','-f',name]);
    if(network)docker(['network','rm',prefix]);
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(directory.includes('sampleflow-entry-check-'));
    rmSync(directory,{recursive:true,force:true});
  }
});
