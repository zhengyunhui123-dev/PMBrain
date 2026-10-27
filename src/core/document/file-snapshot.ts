import {open,stat,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DocumentRuntime} from './resource-policy.ts';

export async function documentFileHash(path:string,runtime:DocumentRuntime){
  const file=await open(path,'r'),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);
  try{for(;;){runtime.signal?.throwIfAborted();const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));}return hash.digest('hex');}
  finally{await file.close();}
}
export async function snapshotDocument(source:string,target:string,runtime:DocumentRuntime){
  await runtime.checkpoint(true);const before=await stat(source),input=await open(source,'r'),output=await open(target,'wx',0o600);
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let size=0;
  try{
    for(;;){runtime.signal?.throwIfAborted();const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;
      if(size>runtime.plan.maxFileBytes)throw new Error('资源保护：文件在读取期间超过本机处理额度');
      hash.update(buffer.subarray(0,bytesRead));let offset=0;while(offset<bytesRead)offset+=(await output.write(buffer,offset,bytesRead-offset,null)).bytesWritten;
      await runtime.checkpoint();
    }
  }finally{await input.close();await output.close();}
  const rawHash=hash.digest('hex');
  const validate=async()=>{const after=await lstat(source);if(after.isSymbolicLink()||after.size!==size||after.dev!==before.dev||after.ino!==before.ino||await documentFileHash(source,runtime)!==rawHash)throw new Error('资料在导入期间已修改，请重新导入：'+source);};
  await validate();return {hash:rawHash,size,validate};
}
