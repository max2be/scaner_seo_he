import { mkdir, access, constants } from 'node:fs/promises';
import { createServer } from 'node:http';
const data=process.env.DATA_DIR??'/data';
await mkdir(data,{recursive:true});await access(data,constants.W_OK);
const port=Number(process.env.WORKER_HEALTH_PORT??9901);
const host=process.env.WORKER_HEALTH_HOST??'127.0.0.1';
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url!=='/health'){res.writeHead(404).end('{}');return;}res.writeHead(200).end(JSON.stringify({status:'ok',component:'worker',stage:'EPIC-01',scannerReady:false}));});
server.listen(port,host);
for(const signal of ['SIGTERM','SIGINT'] as const){process.once(signal,()=>server.close(()=>process.exit(0)));}
