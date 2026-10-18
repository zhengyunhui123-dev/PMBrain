export async function ocrImageInputs(bytes:Buffer,mime:string,signal?:AbortSignal):Promise<Array<{bytes:Buffer;mime:string;label:string}>>{
  const original=[{bytes,mime,label:'Source image'}];
  if(mime!=='image/png'||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return original;
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),pixels=width*height;
  if(pixels<=4096*4096||pixels>64*1024*1024||Math.min(width,height)<512||Math.max(width,height)>16384)return original;
  signal?.throwIfAborted();
  const {createCanvas,loadImage}=await import('@napi-rs/canvas');
  const image=await loadImage(bytes);
  const scale=Math.min(1,2048/Math.max(width,height));
  const canvas=createCanvas(Math.ceil(width*scale),Math.ceil(height*scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const result=[{bytes:canvas.toBuffer('image/png'),mime:'image/png',label:'Overview of the same source image'}];
  const middleX=Math.floor(width/2),middleY=Math.floor(height/2);
  for(const [top,bottom] of [[0,Math.min(height,middleY+128)],[Math.max(0,middleY-128),height]]){
    for(const [left,right] of [[0,Math.min(width,middleX+128)],[Math.max(0,middleX-128),width]]){
      signal?.throwIfAborted();
      canvas.width=right!-left!;canvas.height=bottom!-top!;
      canvas.getContext('2d').drawImage(image,left!,top!,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
      result.push({bytes:canvas.toBuffer('image/png'),mime:'image/png',label:`Overlapping zoom of the same source image, bounds ${left},${top},${right},${bottom}`});
    }
  }
  canvas.width=1;canvas.height=1;
  return result;
}
