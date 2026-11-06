import {expect,test} from 'bun:test';
import {QuickVectorProgress} from '../src/product/tasks/vector-progress';
import type {BrainEngine} from '../src/core/engine';
import {TaskProductProgressSchema} from '../shared/contracts/common';
import {TaskProgressAdapter} from '../src/product/tasks/progress-adapter';

test('向量进度累计本轮全部分块，复用已有向量且同页回调不重复加数',async()=>{
  const engine={executeRaw:async()=>[{slug:'one',total:4,completed:2},{slug:'two',total:6,completed:0}]} as unknown as BrainEngine;
  const progress=await QuickVectorProgress.load(engine,'default',['one','two'],1800000);
  expect(progress.snapshot()).toMatchObject({total:10,completed:2,pages:2,completedPages:0});
  progress.page('one',3);progress.page('one',3);progress.page('two',2);
  expect(progress.snapshot()).toMatchObject({total:10,completed:5});
  progress.complete('one');progress.complete('two');
  expect(progress.snapshot()).toMatchObject({total:10,completed:10,completedPages:2});
});

test('API合同保留本轮向量任务和统计，任务列表省略result时仍可显示关联后台结果',()=>{
  const product=new TaskProgressAdapter('dream_quick').view;
  product.maintenance={scan:{scanned:2,unchanged:0,total:2,incremental:2,complete:true},stage:'done',stages:[],
    entities:{total:0,person:0,project:0,organization:0,company:0,links:0},vectors:[{sourceId:'default',taskId:'task-8',pages:2}]};
  product.database={supported:true,requests:5,writes:2,waitedMs:100,stages:{}};
  expect(TaskProductProgressSchema.parse(product).maintenance?.vectors?.[0].taskId).toBe('task-8');
  expect(TaskProductProgressSchema.parse(product).database?.waitedMs).toBe(100);
});
