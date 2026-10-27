import {test,expect} from 'bun:test';
import express from 'express';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect} from 'node:net';
import {writeAdminUpload,AdminUploadSizeError} from '../src/commands/pmbrain-admin-support';
import {officeFileSizeLimit} from '../src/core/document/resource-policy';

test('浏览器上传逐块写入临时文件，空文件和超限得到明确反馈',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pmbrain-upload-stream-')),path=join(directory,'data-0.docx'),app=express();let next=0;
  app.post('/',async(req,res)=>{try{await writeAdminUpload(req,join(directory,`data-${next++}.docx`),'office');res.json({ok:true});}catch(error){res.status(error instanceof AdminUploadSizeError?413:400).json({error:String(error)});}});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/octet-stream'},body:'streamed upload bytes',signal:AbortSignal.timeout(5000)});
    expect(response.status).toBe(200);expect(await readFile(path,'utf8')).toBe('streamed upload bytes');
    const empty=await fetch(url,{method:'POST',headers:{'content-type':'application/octet-stream'},body:'',signal:AbortSignal.timeout(5000)});expect(empty.status).toBe(400);expect((await empty.json() as any).error).toContain('Upload body is required');
    const oversized=await new Promise<number>((resolve,reject)=>{const target=new URL(url),socket=connect(Number(target.port),'127.0.0.1');let received='';socket.once('connect',()=>socket.write(`POST / HTTP/1.1\r\nHost: ${target.host}\r\nContent-Type: application/octet-stream\r\nContent-Length: ${officeFileSizeLimit(path)+1}\r\nConnection: close\r\n\r\nx`));socket.on('data',part=>{received+=part.toString();const status=received.match(/^HTTP\/1\.1 (\d+)/);if(status){resolve(Number(status[1]));socket.destroy();}});socket.on('error',reject);socket.setTimeout(5000,()=>socket.destroy(new Error('upload test timeout')));});expect(oversized).toBe(413);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
},15000);
