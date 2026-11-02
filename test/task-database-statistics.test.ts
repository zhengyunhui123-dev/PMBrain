import { expect, test } from 'bun:test';
import { addDatabaseStatistic, databaseRequestIsWrite } from '../shared/database-occupancy';
import type { TaskDatabaseStatistics } from '../shared/maintenance-progress';

test('数据库统计按任务阶段累加请求等待，读请求不记作写入',()=>{
  const stats:TaskDatabaseStatistics={supported:true,requests:0,writes:0,waitedMs:0,stages:{}};
  addDatabaseStatistic(stats,'sync',{waitedMs:800,write:true});
  addDatabaseStatistic(stats,'sync',{waitedMs:200,write:false});
  addDatabaseStatistic(stats,'relations',{waitedMs:500,write:true});
  expect(stats).toMatchObject({requests:3,writes:2,waitedMs:1500});
  expect(stats.stages.sync).toEqual({requests:2,writes:1,waitedMs:1000});
  expect(stats.stages.relations).toEqual({requests:1,writes:1,waitedMs:500});
  expect(databaseRequestIsWrite('executeRaw','SELECT * FROM pages')).toBe(false);
  expect(databaseRequestIsWrite('executeRaw','UPDATE pages SET title=$1')).toBe(true);
  expect(databaseRequestIsWrite('upsertChunks')).toBe(true);
});
