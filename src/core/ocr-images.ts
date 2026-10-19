export async function ocrImageInputs(bytes:Buffer,mime:string,signal?:AbortSignal):Promise<Array<{bytes:Buffer;mime:string;label:string}>>{
  const original=[{bytes,mime,label:'Source image'}];
  let width=0,height=0;
  if(mime==='image/png'&&bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  }else if(mime==='image/jpeg'&&bytes.length>=4&&bytes.readUInt16BE(0)===0xffd8){
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==0xff)break;
      while(bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];if(marker===undefined||marker===0xda||marker===0xd9)break;
      if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
      if(offset+2>bytes.length)break;
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=8){height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;}
      offset+=length;
    }
  }else if(mime==='image/webp'&&bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8<=bytes.length){
    const kind=bytes.toString('ascii',12,16);
    if(kind==='VP8X'){
      if(bytes[20]!&2)return original;
      width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;
    }else if(kind==='VP8 '&&bytes.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a]))){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L'&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  }
  const pixels=width*height;
  if(pixels<=4096*4096||pixels>64*1024*1024||Math.min(width,height)<512||Math.max(width,height)>16384)return original;
  signal?.throwIfAborted();
  const {createCanvas,loadImage}=await import('@napi-rs/canvas');
  const image=await loadImage(bytes);
  width=image.width;height=image.height;
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
