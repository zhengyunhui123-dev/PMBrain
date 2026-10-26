import React,{useEffect,useState} from 'react';
import { BookOpen, User, FileText, Download } from 'lucide-react';
import type { WorkbenchAgent } from '../../../shared/workbench-agents';
import type { WorkbenchMessage } from '../../../shared/workbench';
import { MarkdownArticle } from '../pages/Documentation';
import { CopyButton } from '../lib/clipboard';
import { ToolActivity } from './ToolActivity';
import { workbenchRequest } from './useWorkbench';
import { downloadArtifact, ArtifactPreview } from './Artifacts';
import { quoteArtifact } from '../../../src/product/workbench/artifact-quote';
import { visibleAssistantText } from '../../../src/product/workbench/playbook';
import { AgentCards } from './AgentCards';

export function Message({ message, assistantName, assistantEmoji, assistantRole, canRetry, onRetry, canEdit, onEdit, onUndoRules, agents, onAgent, onConversation, onReviseArtifact }: { message: WorkbenchMessage; assistantName: string; assistantEmoji: string; assistantRole?: string; canRetry: boolean; onRetry: () => void; canEdit?: boolean; onEdit?: () => void; onUndoRules?: () => void; agents?: WorkbenchAgent[]; onAgent?: (id: string) => void; onConversation?: (id: string) => void; onReviseArtifact?: (text: string) => void }) {
  const modelLabel = message.modelName || message.model;
  const [now,setNow]=useState(Date.now());
  const [origins,setOrigins]=useState<Record<number,string>>({});
  const [preview, setPreview] = useState<string>();
  const [artifactError, setArtifactError] = useState('');
  useEffect(()=>{if(message.status!=='running')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[message.status]);
  const waitingSeconds=message.request?Math.max(0,Math.floor((now-Date.parse(message.request.startedAt))/1000)):0;
  const visibleText = message.role === 'assistant' ? visibleAssistantText(message.text ?? '', message.toolCalls, { savedSkill: message.savedSkill, recap: true }) : message.text;
  return <article className={`wb-message wb-${message.role}`} data-kind={message.role === 'assistant' ? (assistantRole === '主助手' ? 'main' : 'specialist') : undefined} aria-label={message.role === 'user' ? '你的消息' : '助手回答'}>
    <div className="wb-avatar">{message.role === 'user' ? <User size={17} /> : <span>{assistantEmoji}</span>}</div>
    <div className="wb-message-body"><header><strong>{message.role === 'user' ? '你' : assistantName}</strong><span>{message.role === 'assistant' ? `${assistantRole ? `${assistantRole} · ` : ''}${modelLabel}` : new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></header>
      {message.ruleNotice && <p className="wb-notice" role="status">{message.ruleNotice}{!!message.learnedRules?.length && <button type="button" onClick={onUndoRules} disabled={!onUndoRules}>撤销</button>}</p>}
      {message.playbookNotice ? <p className="wb-notice" role="status">{message.playbookNotice}</p> : null}
      {message.skillNotice ? <p className="wb-notice" role="status">{message.skillNotice}</p> : null}
      {message.knowledge === 'none' && message.status === 'complete' && !message.evidenceGap ? <p className="wb-notice">这次没有从知识库检索到相关资料。下面的内容是模型基于一般知识的回答，请再核对。</p> : null}
      {!!message.attachments?.length && <ul className="wb-attachments">{message.attachments.map(item => <li key={item.id} className={item.preview ? 'wb-thumb' : 'wb-file-card'}>{item.preview ? <img src={item.preview} alt={item.name} /> : <span className="wb-attachment-name">{item.name}</span>}{item.note && <small className="wb-attachment-note">{item.note}</small>}</li>)}</ul>}{!!message.toolCalls?.length && <ToolActivity calls={message.toolCalls} />}{visibleText && <MarkdownArticle markdown={visibleText} citations={message.role === 'assistant' ? message.citations : undefined} />}
      {message.status === 'running' && <p className="wb-progress" role="status"><i />{message.stage || '正在生成回答…'}{message.request&&waitingSeconds>=5?` · 已等待 ${waitingSeconds} 秒`:''}</p>}
      {message.status === 'error' && <p className="wb-error" role="alert">{/工具指令|工具回执|没有写出正文/.test(message.error || "") ? "助手还没有写出正文，请重新生成。可以把主题说得更具体一些。" : /引用|未通过核对/.test(message.error || "") ? "这次回答的资料引用有误，请重试。" : /SQL|checkpoint|检查点|database|TypeError|undefined|ECONN/i.test(message.error || "") ? "这次处理未完成，可以重试。具体原因保留在对话详情中。" : message.error}</p>}
      {message.status === 'cancelled' && <p className="wb-muted">已停止生成，可以重试或继续提问。</p>}
      {agents && onAgent && onConversation && <AgentCards calls={message.toolCalls ?? []} agents={agents} onAgent={onAgent} onConversation={onConversation} />}
      {!!message.artifacts?.length && <div className="wb-deliverables">{message.artifacts.map(item => <div className="wb-artifact-card" key={item.id}><button className="wb-artifact-open" aria-label={`预览 ${item.title}`} onClick={() => setPreview(item.id)}><FileText size={24} /><span><strong>{item.title}</strong><small>{item.revision && item.revision > 1 ? `第 ${item.revision} 版 · ` : ''}{item.publishedPath ? `已保存到 ${item.publishedPath}` : `${item.format === 'docx' ? 'Word 文档' : 'Markdown'} · 点击预览`}</small></span></button>{onReviseArtifact ? <button type="button" onClick={() => onReviseArtifact(quoteArtifact({ id: item.id, revision: item.revision, title: item.title }).text)}>按这份改</button> : null}<button aria-label={`下载 ${item.title}`} title="下载文件" onClick={() => { setArtifactError(''); void downloadArtifact(item.id).catch(error => setArtifactError(String(error))); }}><Download size={16} /></button></div>)}</div>}
      {artifactError && <p className="wb-error" role="alert">{artifactError}</p>}
      {preview ? <ArtifactPreview key={preview} id={preview} onClose={() => setPreview(undefined)} onQuote={onReviseArtifact ? text => { setPreview(undefined); onReviseArtifact(text); } : undefined} /> : null}
      {message.stopReason === 'length' && message.status === 'complete' && <p className="wb-notice">回答因模型长度限制未能一次写完。你可以发送「继续」接着写。</p>}
      {!!message.citations?.length && <details className="wb-citations"><summary><BookOpen size={14} />参考了 {message.citations.length} 条知识与记忆</summary>{message.citations.map((citation, index) => <div key={`${citation.sourceId}/${citation.slug}/${citation.factId??''}`}><b>[{index + 1}] {citation.title}</b><small>{citation.kind==='memory'?'已保存的记忆':`${citation.sourceId} / ${citation.slug}`}</small><p>{citation.snippet}</p>{citation.kind==='memory'&&citation.conversationId&&citation.messageId&&<><button type="button" onClick={()=>void workbenchRequest<{text:string;createdAt:string}>(`/conversations/${citation.conversationId}/memory/${citation.messageId}${citation.memoryHash?`?hash=${citation.memoryHash}`:''}`).then(result=>setOrigins(old=>({...old,[index]:`${new Date(result.createdAt).toLocaleString()}\n${result.text}`}))).catch(reason=>setOrigins(old=>({...old,[index]:String(reason)})))}>查看对话出处</button>{origins[index]&&<p>{origins[index]}</p>}</>}</div>)}</details>}
      {message.status !== "running" && (message.contextManifest || message.contextNote || message.error || message.requestHistory?.length) ? <details className="wb-diagnostics"><summary>对话详情</summary>
      {message.contextNote && <p className="wb-muted">{message.contextNote}</p>}
      {!!message.contextManifest?.skills?.length && <p className="wb-muted">使用技能：{message.contextManifest.skills.map(skill => skill.displayName).join('、')}</p>}
      {message.contextManifest?.skillNote && <p className="wb-notice">{message.contextManifest.skillNote}</p>}
      {message.contextManifest ? <details className="wb-citations"><summary>上下文信息</summary><div>{message.contextManifest.task ? <p>当前任务：{message.contextManifest.task.goal}{message.contextManifest.task.inherited ? '（沿用当前任务）' : ''}</p> : null}{message.contextManifest.rules.some(rule => rule.state === 'active') ? <p>规则在用：{message.contextManifest.rules.filter(rule => rule.state === 'active').map(rule => rule.text).join('、')}</p> : null}{message.contextManifest.rules.some(rule => rule.state === 'replaced') ? <p>规则已替代：{message.contextManifest.rules.filter(rule => rule.state === 'replaced').map(rule => rule.replacedBy ? `${rule.text} → ${rule.replacedBy}` : rule.text).join('、')}</p> : null}<p>{message.contextManifest.knowledge ? '知识检索已开' : '知识检索已关'}，引用 {message.contextManifest.citations} 条{message.contextManifest.evidenceTask ? '，本期资料任务' : ''}</p><p>输入预算 {message.contextManifest.budget.inputBudget} / 窗口 {message.contextManifest.budget.window}</p>{message.contextManifest.items?.length ? <p>{message.contextManifest.items.map(item => item.state === 'omitted' ? `未能放入 ${item.ref}` : `已重新带上 ${item.ref}`).join('；')}</p> : null}{message.contextManifest.omitted?.length ? <p>{message.contextManifest.omitted.join('；')}</p> : null}</div></details> : null}
      {!!message.requestHistory?.length&&message.status==='error'&&<details className="wb-citations"><summary>模型请求</summary>{message.requestHistory.map((request,index)=><small key={index}>{request.model} · 尝试 {request.attempt} · {Math.round(request.elapsedMs/1000)} 秒 · {request.errorKind||'完成'} · 输入 {request.inputTokens??'未返回'} / 输出 {request.outputTokens??'未返回'} Token · 输出上限 {request.outputLimit??'未返回'}{request.usageUnknown?' · 失败请求消耗未知':''}</small>)}</details>}
      {message.error && <p>{message.error}</p>}
      </details> : null}
      {message.status !== 'running' && <footer>{visibleText && <CopyButton value={visibleText} />}{canEdit && <button onClick={onEdit}>修改问题</button>}{canRetry && <button onClick={onRetry}>重新生成</button>}</footer>}
    </div>
  </article>;
}
