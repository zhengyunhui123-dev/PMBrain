import React from 'react';
import { desktopApi } from '../lib/product-fetch';
import { taskModelSetupIssue } from './model-readiness';
import type { ConsoleRun } from '../lib/shared';

export function ModelSetupNotice({ run }: { run: ConsoleRun }) {
  const issue = taskModelSetupIssue(run);
  if (!issue) return null;
  return <div className="model-setup-notice" role="alert">
    <b>{issue.title}</b><p>{issue.detail}</p>
    {desktopApi() ? <button type="button" className="pm-ghost" onClick={() => { window.location.hash = issue.target; }}>去配置模型</button> : <p>请在 PMBrain 桌面端打开「设置 → 知识库模型配置」。</p>}
  </div>;
}
