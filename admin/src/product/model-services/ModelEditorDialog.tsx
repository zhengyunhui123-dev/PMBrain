import { X } from "lucide-react";
import {useEffect,useState} from 'react';
import {api} from '../../api';
import {modelBilling,DEFAULT_USD_TO_CNY} from '../../../../shared/model-billing';
import { type ModelCapability, type ServiceModel } from "../../../../shared/model-services";

import { capabilityItems } from "./support";
import type { ModelServicesController } from "./useModelServices";

export function ModelEditorDialog({ model }: { model: ModelServicesController }) {
  const { originalId, editor, setEditor, editorError, setEditorError, commit } = model;
  const desktop = model.desktop!;
  const service = model.service!;
  const [usdToCny,setUsdToCny]=useState(DEFAULT_USD_TO_CNY);
  useEffect(()=>{void api.dreamSettings().then(value=>setUsdToCny(value.usdToCny??DEFAULT_USD_TO_CNY)).catch(()=>{});},[]);
  const billing=editor&&service?modelBilling(service,editor,usdToCny):null;
  return (
    <>
      {editor && (
        <div className="model-modal-overlay">
          <section className="model-modal" role="dialog" aria-modal="true" aria-label="模型设置">
            <header>
              <h2>{originalId ? "模型设置" : "添加模型"}</h2>
              <button type="button" aria-label="关闭模型设置" onClick={() => setEditor(null)}>
                <X size={18} />
              </button>
            </header>
            <label>
              模型 ID *
              <input
                required
                value={editor.id}
                onChange={(event) => setEditor({ ...editor, id: event.target.value })}
                placeholder="平台提供的模型 ID"
              />
            </label>
            <label>
              显示名称
              <input value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
            </label>
            <div className="model-form-grid">
              <label>
                分组
                <input value={editor.group} onChange={(event) => setEditor({ ...editor, group: event.target.value })} />
              </label>
              <label>
                模型类型
                <select
                  value={editor.kind}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      kind: event.target.value as ServiceModel["kind"],
                      typeOverride: true,
                    })
                  }
                >
                  <option value="chat">对话模型</option>
                  <option value="embedding">向量模型</option>
                  <option value="unknown">待确认类型</option>
                </select>
              </label>
            </div>
            {editor.kind === "embedding" && (
              <label>
                向量维度
                <input
                  type="number"
                  min="1"
                  step="1"
                  placeholder="留空后在检测连接时自动识别"
                  value={editor.dimensions ?? ""}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      dimensions: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
                <small>保存用途时仍会通过原有流程验证实际维度。</small>
              </label>
            )}
            <label>能力标签</label>
            <div className="capability-controls">
              {capabilityItems.map(([value, label, Icon]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={editor.capabilities.includes(value)}
                  onClick={() =>
                    setEditor({
                      ...editor,
                      capabilities: editor.capabilities.includes(value)
                        ? editor.capabilities.filter((item) => item !== value)
                        : [...editor.capabilities, value as ModelCapability],
                    })
                  }
                >
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>
            <p className="model-hint">标签用于辨认模型能力，请以平台实际支持为准。</p>
            <details className="model-more" open>
              <summary>价格与更多设置</summary>
              <div className="model-form-grid">
                {(
                  [
                    ["inputPriceCny", "输入价格", "元 / 百万 Token，缓存未命中"],
                    ["outputPriceCny", "输出价格", "元 / 百万 Token，包含模型计费的思考输出"],
                    ["cacheReadPriceCny", "缓存命中输入价格", "元 / 百万 Token，留空时按普通输入价保守估算"],
                  ] as const
                ).map(([key, label, hint]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="0"
                      step="any"
                      placeholder="未设置"
                      value={editor[key] ?? (key==='inputPriceCny'?billing?.inputCny:key==='outputPriceCny'?billing?.outputCny:billing?.cacheReadCny) ?? ""}
                      onChange={(event) =>
                        setEditor({
                          ...editor,
                          [key]: event.target.value === "" ? undefined : Number(event.target.value),
                          ...(key!=='outputPriceCny'&&editor.outputPriceCny===undefined&&billing?{outputPriceCny:billing.outputCny}:{}),
                          ...(key!=='inputPriceCny'&&editor.inputPriceCny===undefined&&billing?{inputPriceCny:billing.inputCny}:{}),
                          pricingSource:'manual',
                          pricingUpdatedAt:new Date().toISOString(),
                        })
                      }
                    />
                    <small>{hint}</small>
                  </label>
                ))}
              </div>
              <p className="model-hint">{editor.pricingSource==='manual'?'使用人工单价，同步模型会保留。':billing?.source.startsWith('https://mimo.mi.com')||editor.pricingUrl?.startsWith('https://mimo.mi.com')?'使用小米官方人民币按量价格，同步模型时更新。':editor.pricingSource==='official'?'使用已核对的官方参考价，美元报价按整理设置汇率折算。':editor.pricingSource==='provider'?'使用服务商模型接口返回的价格。':billing?'美元报价已按整理设置中的汇率折算为人民币。':'尚无可核对的价格，请同步模型或填写单价；有费用上限的整理不会跳过价格检查。'}{editor.pricingUpdatedAt?` 更新于 ${new Date(editor.pricingUpdatedAt).toLocaleDateString()}`:''}</p>
              <label>
                上下文长度（Token）
                <input
                  type="number"
                  min="0"
                  value={editor.contextWindow ?? ""}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      contextWindow: event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                />
              </label>
            </details>
            <footer>
              {editorError && <span role="alert">{editorError}</span>}
              <button type="button" onClick={() => setEditor(null)}>
                取消
              </button>
              <button
                type="button"
                className="model-primary"
                onClick={() => {
                  if (!editor.id.trim()) {
                    setEditorError("请填写模型 ID");
                    return;
                  }
                  if (service.models.some((model) => model.id === editor.id.trim() && model.id !== originalId)) {
                    setEditorError("模型 ID 已存在");
                    return;
                  }
                  commit(
                    (item) => ({
                      ...item,
                      models: [
                        ...item.models.filter((model) => model.id !== originalId),
                        {
                          ...editor,
                          id: editor.id.trim(),
                          name: editor.name.trim() || editor.id.trim(),
                          group: editor.group.trim() || "其他模型",
                        },
                      ],
                    }),
                    true,
                  );
                  setEditor(null);
                }}
              >
                确认
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
