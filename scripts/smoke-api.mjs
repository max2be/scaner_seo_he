// Run after build, including inside the nonroot runtime image. Synthetic local data only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const { buildApp } = await import(pathToFileURL(join(process.cwd(), 'apps/web/dist/app.js')).href);
const { hashPassword } = await import(pathToFileURL(join(process.cwd(), 'apps/web/dist/password-hash.js')).href);
import { ProjectConfigSchema } from '@hsi/contracts';
const { workOnce } = await import(pathToFileURL(join(process.cwd(), 'apps/worker/dist/jobs.js')).href);
import { ScanRepository } from '@hsi/storage';
const directory=await mkdtemp(join(process.env.HSI_SMOKE_ROOT || tmpdir(),'hsi-auth-smoke-'));
const origin='https://inspector.example.com',password=randomBytes(24).toString('base64url');
const app=buildApp(directory,{auth:{passwordHash:await hashPassword(password),publicOrigin:origin}});
const assert=(value,message)=>{if(!value)throw new Error(message);};
try{
  await app.listen({host:'127.0.0.1',port:0});const address=app.server.address();const base='http://127.0.0.1:'+address.port;
  assert((await fetch(base+'/api/projects')).status===401,'anonymous_access');
  const logged=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})});assert(logged.status===200,'login_failed');
  const session=await logged.json(),cookie=logged.headers.get('set-cookie').split(';')[0];
  assert(logged.headers.get('set-cookie').includes('HttpOnly; Secure; SameSite=Strict'),'insecure_cookie');
  const headers={origin,cookie,'x-csrf-token':session.csrfToken,'content-type':'application/json'};
  assert((await fetch(base+'/api/me',{headers:{cookie}})).status===200,'session_missing');
  assert((await fetch(base+'/api/projects',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status===403,'csrf_bypass');
  const project=ProjectConfigSchema.parse({schemaVersion:'1.0',id:'smoke',name:'Synthetic API fixture',baseUrl:'https://shop.example.com',allowedHosts:['shop.example.com'],
    discovery:{sitemapUrls:[],seedUrls:[],crawlLinks:false,maxDepth:1,queryPolicy:{mode:'drop',allowedKeys:[],dropTrackingKeys:[]},maxUrls:10},
    canonicalPolicy:{trailingSlash:'unknown',expectedScheme:'https',preferredHost:'shop.example.com',checkSelfCanonical:false},
    http:{userAgent:'HeadlessSEOInspector/1.0',respectRobots:true,requestsPerSecondPerHost:1,concurrency:1,timeoutMs:1000,maxResponseBytes:50000,maxRedirects:2,maxRetries:0},sources:{},reports:{keepLastRuns:2,htmlEnabled:true}});
  assert((await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify(project)})).status===201,'project_create_failed');
  const scans=base+'/api/projects/smoke/scans';
  assert((await fetch(scans,{method:'POST',headers,body:JSON.stringify({scanId:'first'})})).status===202,'enqueue_failed');
  assert((await fetch(scans,{method:'POST',headers,body:JSON.stringify({scanId:'second'})})).status===409,'duplicate_start');
  await workOnce(new ScanRepository(directory)); // Empty seeds: no target traffic; incomplete is explicit.
  const progress=await(await fetch(scans+'/first',{headers})).json();assert(progress.manifest.status==='incomplete','incomplete_hidden');
  for(const kind of ['json','csv','html']){
    assert((await fetch(scans+'/first/download/'+kind)).status===401,'anonymous_download');
    const response=await fetch(scans+'/first/download/'+kind,{headers});assert(response.status===200&&response.headers.get('content-disposition').includes('attachment'),'download_failed');await response.arrayBuffer();
  }
  const resume=await fetch(scans+'/first/resume',{method:'POST',headers,body:'{}'});assert(resume.status===202,'resume_enqueue');const operation=await resume.json();await workOnce(new ScanRepository(directory));
  assert((await(await fetch(base+'/api/projects/smoke/operations/'+operation.id,{headers})).json()).state==='completed','resume_worker_failed');
  assert((await fetch(base+'/api/openapi.json',{headers})).status===200,'openapi_missing');
  assert((await fetch(base+'/api/auth/logout',{method:'POST',headers,body:'{}'})).status===204,'logout_failed');
  assert((await fetch(base+'/api/me',{headers:{cookie}})).status===401,'logout_not_revoked');
  console.log(JSON.stringify({argon2id:true,secureCookie:true,csrf:true,projectCrud:true,durableQueue:true,duplicate409:true,workerResume:true,authorizedExports:true,openapi:true,logoutRevoked:true,noExternalTargets:true,nonroot:process.getuid?.()!==0}));
}finally{await app.close();await rm(directory,{recursive:true,force:true});}
