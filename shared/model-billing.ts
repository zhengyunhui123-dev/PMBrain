import type {ModelService,ServiceModel} from './model-services.js';

export const DEFAULT_USD_TO_CNY=7;
export const DEFAULT_DREAM_BUDGET_CNY=20;
export const MIMO_OFFICIAL_PRICES={
 'mimo-v2.6-pro':{inputCny:3,outputCny:6,cacheReadCny:0.025,inputUsd:0.435,outputUsd:0.87,cacheReadUsd:0.0036},
 'mimo-v2.6-flash':{inputCny:1,outputCny:2,cacheReadCny:0.02,inputUsd:0.14,outputUsd:0.28,cacheReadUsd:0.0028},
 'mimo-v2.6-pro-ultraspeed':{inputCny:30,outputCny:60,cacheReadCny:0.25,inputUsd:4.35,outputUsd:8.7,cacheReadUsd:0.036},
} as const;
export interface ModelBilling {inputCny:number;outputCny:number;cacheReadCny?:number;cacheWriteCny?:number;source:string}
const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function officialMiMoModel(model:string):boolean{return Object.hasOwn(MIMO_OFFICIAL_PRICES,model.toLowerCase());}
export function isDirectMiMo(service:Pick<ModelService,'provider'|'baseUrl'>):boolean{
 try{return service.provider==='mimo'&&new URL(service.baseUrl).hostname==='api.xiaomimimo.com';}catch{return false;}
}
export function modelBilling(service:Pick<ModelService,'provider'|'baseUrl'>,model:ServiceModel,usdToCny=DEFAULT_USD_TO_CNY):ModelBilling|null{
 if(valid(model.inputPriceCny)&&valid(model.outputPriceCny))return {inputCny:model.inputPriceCny,outputCny:model.outputPriceCny,cacheReadCny:model.cacheReadPriceCny,cacheWriteCny:model.cacheWritePriceCny,source:model.pricingSource??'manual'};
 if(isDirectMiMo(service)&&officialMiMoModel(model.id))return {...MIMO_OFFICIAL_PRICES[model.id.toLowerCase() as keyof typeof MIMO_OFFICIAL_PRICES],source:'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go'};
 if(service.provider==='mimo'&&model.pricingSource===undefined)return null;
 if(valid(model.inputPrice)&&valid(model.outputPrice))return {inputCny:model.inputPrice*usdToCny,outputCny:model.outputPrice*usdToCny,cacheReadCny:valid(model.cacheReadPrice)?model.cacheReadPrice*usdToCny:undefined,source:model.pricingSource??'legacy_usd'};
 if(['ollama','service-lmstudio'].includes(service.provider))return {inputCny:0,outputCny:0,source:'local'};
 return null;
}
export function parseMiMoPricing(html:string,model:string):Partial<ServiceModel>{
 if(!officialMiMoModel(model))throw new Error('未找到该模型的官方价格页');
 const text=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|\s+/g,' ');
 if(html.includes('模型国内定价')&&html.includes('模型海外定价')){
  const sections=[html.slice(html.indexOf('模型国内定价'),html.indexOf('模型海外定价')),html.slice(html.indexOf('模型海外定价'))];
  const find=(section:string,symbol:RegExp)=>{const row=section.split(/<tr\b/i).map(row=>row.split(/<\/tr>/i)[0]!.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ')).find(row=>row.split(' ').includes(model));return row?[...row.matchAll(symbol)].map(match=>Number(match[1])):[];};
  const cny=find(sections[0]!,/[¥￥]\s*([\d.]+)/g),usd=find(sections[1]!,/\$\s*([\d.]+)/g);
  if(cny.length<3||cny.some(value=>!Number.isFinite(value)||value<0))throw new Error('官方定价表没有该模型的有效实时单价，未更新价格');
  return {inputPriceCny:cny[1],outputPriceCny:cny[2],cacheReadPriceCny:cny[0],inputPrice:usd[1],outputPrice:usd[2],cacheReadPrice:usd[0],pricingSource:'official',pricingUrl:'https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go',pricingUpdatedAt:new Date().toISOString()};
 }
 const cny=text.slice(text.indexOf('人民币'),text.indexOf('美元',text.indexOf('人民币')));
 const usd=text.slice(text.indexOf('美元',text.indexOf('人民币')));
 const read=(body:string,label:string,symbol:string)=>{const match=body.match(new RegExp(label+'\\s*'+symbol+'\\s*([\\d.]+)'));const value=match?Number(match[1]):NaN;return Number.isFinite(value)&&value>=0?value:undefined;};
 const inputPriceCny=read(cny,'输入（缓存未命中）','¥'),outputPriceCny=read(cny,'输出','¥');
 if(inputPriceCny===undefined||outputPriceCny===undefined)throw new Error('官方价格页未返回可识别的人民币单价，未更新价格');
 return {inputPriceCny,outputPriceCny,cacheReadPriceCny:read(cny,'输入（缓存命中）','¥'),inputPrice:read(usd,'输入（缓存未命中）','\\$'),outputPrice:read(usd,'输出','\\$'),cacheReadPrice:read(usd,'输入（缓存命中）','\\$'),pricingSource:'official',pricingUrl:`https://mimo.mi.com/models/zh-CN/${model}`,pricingUpdatedAt:new Date().toISOString()};
}
export function mergeModelBilling(existing:ServiceModel,incoming:ServiceModel):ServiceModel{
 const merged={...incoming,...existing};
 if(existing.pricingSource==='manual'||existing.pricingSource===undefined&&(valid(existing.inputPriceCny)||valid(existing.outputPriceCny)))return merged;
 for(const key of ['inputPrice','outputPrice','inputPriceCny','outputPriceCny','cacheReadPrice','cacheReadPriceCny','cacheWritePriceCny','pricingSource','pricingUrl','pricingUpdatedAt'] as const)if(incoming[key]!==undefined)(merged as any)[key]=incoming[key];
 return merged;
}
