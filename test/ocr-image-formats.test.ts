import {expect,test} from 'bun:test';
import {createCanvas} from '@napi-rs/canvas';
import {ocrImageInputs} from '../src/core/ocr-images';

for(const mime of ['image/jpeg','image/webp'] as const)test(`大幅 ${mime} 复用总览与四块细节，普通图片保持原始单图`,async()=>{
  const canvas=createCanvas(4200,4100);const context=canvas.getContext('2d');if(mime==='image/jpeg'){context.fillStyle='white';context.fillRect(0,0,4200,4100);}context.fillStyle='black';context.fillRect(2000,2000,20,20);
  const bytes=mime==='image/jpeg'?canvas.toBuffer('image/jpeg',95):canvas.toBuffer('image/webp',95),before=Buffer.from(bytes);
  const result=await ocrImageInputs(bytes,mime);expect(result).toHaveLength(5);expect(bytes.equals(before)).toBe(true);expect(result.every(image=>image.mime==='image/png')).toBe(true);
  const small=createCanvas(64,64).toBuffer(mime);expect(await ocrImageInputs(small,mime)).toEqual([{bytes:small,mime,label:'Source image'}]);
});

test('不解码未知格式、动画和畸形头，超过像素上限的输入不扩大',async()=>{
  for(const mime of ['image/gif','image/avif','image/jpeg','image/webp']){
    const bytes=Buffer.from('invalid image');expect((await ocrImageInputs(bytes,mime))[0]?.bytes).toBe(bytes);
  }
  const header=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(header);header.writeUInt32BE(16384,16);header.writeUInt32BE(16384,20);
  expect((await ocrImageInputs(header,'image/png'))[0]?.bytes).toBe(header);
  const animated=Buffer.alloc(30);animated.write('RIFF');animated.writeUInt32LE(22,4);animated.write('WEBPVP8X',8);animated[20]=2;animated.writeUIntLE(4199,24,3);animated.writeUIntLE(4099,27,3);
  expect((await ocrImageInputs(animated,'image/webp'))[0]?.bytes).toBe(animated);
  const lossless=Buffer.alloc(30);lossless.write('RIFF');lossless.writeUInt32LE(22,4);lossless.write('WEBPVP8L',8);lossless[20]=0x2f;lossless.writeUInt32LE(((16383<<14)|16383)>>>0,21);
  expect((await ocrImageInputs(lossless,'image/webp'))[0]?.bytes).toBe(lossless);
});
