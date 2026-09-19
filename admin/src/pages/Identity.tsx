import React, { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';
import { LoadingBlock } from './console-shared';

interface IdentityMember {
  entity_id: string;
  source_id: string;
  slug: string;
  canonical?: boolean;
}

interface IdentityGroup {
  entity_id: string;
  canonical: IdentityMember | null;
  members: IdentityMember[];
}

interface OntologyValue {
  dimension: string;
  value: string;
  confidence: number;
  source: string | null;
  status: string;
  fact_id?: number;
}

export function IdentityPage() {
  const [entityId, setEntityId] = useState('zhang-san');
  const [sourceId, setSourceId] = useState('youdao');
  const [slug, setSlug] = useState('people/zhang-san');
  const [canonical, setCanonical] = useState(false);
  const [groups, setGroups] = useState<IdentityGroup[] | null>(null);
  const [ontologyEntity, setOntologyEntity] = useState('people/zhang-san');
  const [ontology, setOntology] = useState<OntologyValue[] | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadGroups = useCallback(async () => {
    try {
      const payload = await api.entityIdentity(entityId ? { entity_id: entityId } : undefined) as { identities?: IdentityGroup[] };
      setGroups(payload.identities ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [entityId]);

  useEffect(() => { void loadGroups(); }, [loadGroups]);

  const link = async () => {
    setBusy(true);
    setNotice('');
    try {
      await api.linkEntityIdentity({
        entity_id: entityId.trim(),
        source_id: sourceId.trim(),
        slug: slug.trim(),
        ...(canonical ? { canonical: true } : {}),
      });
      setNotice(`已关联 ${sourceId.trim()} / ${slug.trim()}`);
      await loadGroups();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const loadOntology = async () => {
    setBusy(true);
    try {
      const rows = await api.ontology(ontologyEntity.trim()) as OntologyValue[];
      setOntology(Array.isArray(rows) ? rows : []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!groups && !error) return <LoadingBlock text="正在读取人物关联…" />;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            人物关联
            <InfoIcon title="人物关联">
              手工把不同来源里的同一个人连起来，例如有道笔记的张三和会议纪要里的张总。不会按中文名自动合并。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">同一个身份组可以挂多个来源的页面。当前角色等本体值也在这里查看。</p>
        </div>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {notice && <div className="pm-card pm-ok">{notice}</div>}
      <div className="daily-grid">
        <article className="pm-card daily-card">
          <header>
            <Users aria-hidden="true" />
            <div>
              <h2>手工关联</h2>
              <p>示例：youdao 的 people/zhang-san 与 meetings 的 people/zhang-zong</p>
            </div>
          </header>
          <div className="daily-form">
            <label>身份组 ID<input value={entityId} onChange={(event) => setEntityId(event.target.value)} placeholder="zhang-san" /></label>
            <label>来源 ID<input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="youdao 或 meetings" /></label>
            <label>页面 slug<input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="people/zhang-san" /></label>
            <label className="daily-check"><input type="checkbox" checked={canonical} onChange={(event) => setCanonical(event.target.checked)} />设为这个人的主页面</label>
            <button type="button" className="pm-primary" disabled={busy} onClick={() => void link()}>
              {busy ? '保存中…' : '关联这个页面'}
            </button>
          </div>
          <ul className="daily-loop-list">
            {(groups ?? []).map((group) => (
              <li key={group.entity_id}>
                <div>
                  <b>{group.entity_id}</b>
                  <small>{group.members.map((member) => `${member.source_id}/${member.slug}${member.canonical ? '（主）' : ''}`).join('、') || '还没有成员'}</small>
                </div>
              </li>
            ))}
          </ul>
        </article>
        <article className="pm-card daily-card">
          <header>
            <div>
              <h2>当前本体</h2>
              <p>查看某个人现在的角色、职位等当前值</p>
            </div>
          </header>
          <div className="daily-form">
            <label>实体页面<input value={ontologyEntity} onChange={(event) => setOntologyEntity(event.target.value)} placeholder="people/zhang-san" /></label>
            <button type="button" className="pm-ghost" disabled={busy} onClick={() => void loadOntology()}>查看当前值</button>
          </div>
          {ontology && ontology.length === 0 && <p className="pm-hint">这个人还没有本体当前值。</p>}
          {ontology && ontology.length > 0 && (
            <ul className="daily-loop-list">
              {ontology.map((row) => (
                <li key={`${row.dimension}-${row.fact_id ?? row.value}`}>
                  <div>
                    <span className="daily-pill">{row.dimension}</span>
                    <b>{row.value}</b>
                    <small>{row.status}{row.source ? ` · 来源 ${row.source}` : ''}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>
    </div>
  );
}
