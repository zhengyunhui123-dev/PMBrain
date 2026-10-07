import { createEngine } from '../src/core/engine-factory.ts';
import { reportLegacyPageTypes } from '../src/core/pmbrain-adapters/legacy-page-type-report.ts';
const databaseUrl=process.argv.find(arg=>arg.startsWith('--database-url='))?.slice(15);
const sourceId=process.argv.find(arg=>arg.startsWith('--source-id='))?.slice(12);
if(!databaseUrl)throw new Error('请提供 --database-url=Postgres连接地址；本报告只读，不自动选择或打开正在运行的 PGLite 目录。');
const engine=await createEngine({engine:'postgres',database_url:databaseUrl});
await engine.connect({database_url:databaseUrl});
try {
  await engine.executeRaw('SET default_transaction_read_only=true');
  process.stdout.write(JSON.stringify(await reportLegacyPageTypes(engine,sourceId),null,2)+'\n');
}finally{await engine.disconnect();}
