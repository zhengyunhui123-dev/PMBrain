import { expect, test } from 'bun:test';
import { SidecarResourceMonitor, resourcePressure, readSidecarResources } from '../src/main/sidecar/resource-monitor.js';

test('受控进程正常退出后返回空采样，不误报为监控失败',async()=>{
  const child=Bun.spawn([process.execPath,'-e','process.exit(0)'],{stdout:'ignore',stderr:'ignore'});
  await child.exited;
  expect(await readSidecarResources(child.pid)).toBeNull();
},10000);

test('使用提交内存识别换页风险，系统余量不足也停止，不只检查物理驻留内存',()=>{
  expect(resourcePressure({bytes:3*1024**3,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3})).toContain('内存');
  expect(resourcePressure({bytes:100*1024**2,availableBytes:500*1024**2,commitHeadroomBytes:10*1024**3})).toContain('系统');
  expect(resourcePressure({bytes:100*1024**2,availableBytes:10*1024**3,commitHeadroomBytes:500*1024**2})).toContain('系统');
  expect(resourcePressure({bytes:100*1024**2,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3})).toBeNull();
});

test('监控请求不重叠，停止后迟到采样不能终止进程，只触发一次保护',async()=>{
  let release!:(value:any)=>void;let reads=0;let stops=0;
  const monitor=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
  monitor.start();await Bun.sleep(60);expect(reads).toBe(1);monitor.stop();
  release({bytes:5*1024**3,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3});
  await Bun.sleep(40);expect(stops).toBe(0);expect(reads).toBe(1);
  const active=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>({bytes:5*1024**3,availableBytes:10*1024**3,commitHeadroomBytes:10*1024**3})});
  active.start();await Bun.sleep(60);active.stop();expect(stops).toBe(1);
});

test('连续采样失败时明确停止，创建时间改变时不触碰复用的 PID',async()=>{
  let failures=0;let stops=0;
  const failed=new SidecarResourceMonitor(12345,async(message,sample)=>{expect(message).toContain('无法读取内存');expect(sample).toBeNull();stops++;},{intervalMs:10,read:async()=>{failures++;throw new Error('模拟 WMI 不可用');}});
  failed.start();await Bun.sleep(100);failed.stop();expect(failures).toBe(3);expect(stops).toBe(1);
  let reads=0;const time=new Date().toISOString();
  const reused=new SidecarResourceMonitor(12345,async()=>{stops++;},{intervalMs:10,read:async()=>({bytes:++reads===1?100:5*1024**3,availableBytes:10*1024**3,startedAt:reads===1?time:new Date(Date.parse(time)+1000).toISOString()})});
  reused.start();await Bun.sleep(100);reused.stop();expect(reads).toBe(2);expect(stops).toBe(1);
});
