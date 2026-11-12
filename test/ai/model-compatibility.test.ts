import {expect,test} from 'bun:test';
import {defaultMaxOutputTokens,isThinkingModel} from '../../src/core/ai/model-compatibility.ts';
import {applyMimoChatCompletionBody} from '../../src/core/ai/recipes/mimo.ts';
import {applyOfficialCompletionTokenField} from '../../src/core/ai/provider-chat-body.ts';
import {reasoningOffOptions} from '../../src/core/ai/model-compatibility.ts';
import {classifyChatError,isStructuredOutputRejection,isReasoningControlRejection} from '../../src/core/ai/errors.ts';

test('思考空间识别兼容端点、大小写和模型路径，普通及专用模型保持小上限',()=>{
  for(const model of ['custom-openai:Qwen3.6-35B-A3B','ollama:qwen3.6:35b','custom-openai:Qwen/Qwen3-8B','custom-openai:qwen-plus','custom-openai:qwen3.5-plus','custom-openai:qwq-32b','custom-openai:deepseek-r1','deepseek:deepseek-flash','deepseek:deepseek-v4-pro','custom-openai:glm-4.6','custom-openai:gpt-oss-20b','google:gemini-2.5-pro','google:gemini-3.5-flash','openai:o3-mini','openai:gpt-6-astra','mimo:mimo-v2.6-flash','mimo:mimo-v2.6-pro']){
    expect(isThinkingModel(model)).toBe(true);expect(defaultMaxOutputTokens(model)).toBe(32000);
  }
  for(const model of ['custom-openai:qwen2.5-7b','custom-openai:qwen3-coder','custom-openai:qwen3-embedding:8b','openai:gpt-4o','custom-openai:unknown'])expect(defaultMaxOutputTokens(model)).toBe(4096);
});

test('MiMo 的 OpenAI 接口只保留官方输出上限字段',()=>{
  const moved:Record<string,unknown>={model:'mimo-v2.6-flash',max_tokens:4096,thinking:{type:'disabled'}};
  expect(applyMimoChatCompletionBody(moved)).toBe(true);
  expect(moved).toEqual({model:'mimo-v2.6-flash',max_completion_tokens:4096,thinking:{type:'disabled'}});
  const official:Record<string,unknown>={max_completion_tokens:1024,max_tokens:1024};
  expect(applyMimoChatCompletionBody(official)).toBe(true);
  expect(official).toEqual({max_completion_tokens:1024});
  const plain:Record<string,unknown>={model:'mimo-v2.6-flash'};
  expect(applyMimoChatCompletionBody(plain)).toBe(false);
});

test('DeepSeek 保持官方 max_tokens 并关闭思考，千问官方接口改用完整输出上限',()=>{
  expect(reasoningOffOptions('deepseek:deepseek-v4-flash')).toEqual({thinking:{type:'disabled'}});
  expect(reasoningOffOptions('custom-openai:deepseek-v4-pro','http://127.0.0.1:9/v1')).toEqual({thinking:{type:'disabled'}});
  expect(reasoningOffOptions('custom-openai:qwen-plus','https://dashscope.aliyuncs.com/compatible-mode/v1')).toEqual({enable_thinking:false});
  expect(reasoningOffOptions('custom-openai:qwen3.6-35b-a3b','https://maas.qianwenaiapi.com/compatible-mode/v1')).toEqual({enable_thinking:false});
  expect(reasoningOffOptions('custom-openai:qwen3.6-35b-a3b','http://127.0.0.1:9/v1')).toEqual({chat_template_kwargs:{enable_thinking:false}});
  expect(reasoningOffOptions('ollama:qwen3.6:35b')).toEqual({think:false,reasoningEffort:'none'});
  const qwen:Record<string,unknown>={model:'qwen3.5-plus',max_tokens:32000,enable_thinking:false};
  expect(applyOfficialCompletionTokenField('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',qwen)).toBe(true);
  expect(qwen).toEqual({model:'qwen3.5-plus',max_completion_tokens:32000,enable_thinking:false});
  const deepseek:Record<string,unknown>={model:'deepseek-v4-flash',max_tokens:32000,thinking:{type:'disabled'}};
  expect(applyOfficialCompletionTokenField('https://api.deepseek.com/v1/chat/completions',deepseek)).toBe(false);
  expect(deepseek.max_tokens).toBe(32000);
  const local:Record<string,unknown>={model:'Qwen3.6-35B-A3B',max_tokens:32000};
  expect(applyOfficialCompletionTokenField('http://127.0.0.1:9/v1/chat/completions',local)).toBe(false);
  expect(local.max_tokens).toBe(32000);
});

test('参数拒绝只识别明确的请求兼容错误，鉴权、限流及服务故障不降级',()=>{
  const wrapped={cause:{statusCode:400,responseBody:'unknown parameter chat_template_kwargs.enable_thinking'}};
  expect(isReasoningControlRejection(wrapped)).toBe(true);
  expect(isStructuredOutputRejection({status:422,message:'response_format json_schema unsupported'})).toBe(true);
  for(const status of [401,403,429,500]){
    expect(isReasoningControlRejection({status,message:'enable_thinking unsupported'})).toBe(false);
    expect(isStructuredOutputRejection({status,message:'response_format unsupported'})).toBe(false);
  }
  expect(isReasoningControlRejection({status:400,message:'maximum context length exceeded'})).toBe(false);
  expect(classifyChatError({cause:{statusCode:429}})).toBe('rate_limit');
  expect(classifyChatError({cause:{name:'TimeoutError'}})).toBe('timeout');
  expect(classifyChatError({cause:{code:'ECONNRESET'}})).toBe('network');
  expect(classifyChatError(new Error('unknown certificate verification error'))).toBe('network');
  expect(classifyChatError({cause:{code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}})).toBe('network');
});
