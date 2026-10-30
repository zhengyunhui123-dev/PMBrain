export async function settleOcrRequests<T>(requests:Promise<T>[]):Promise<T[]>{
  const results=await Promise.allSettled(requests);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  return results.map(result=>(result as PromiseFulfilledResult<T>).value);
}
