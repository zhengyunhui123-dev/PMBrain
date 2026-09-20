import React, { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { api } from '../api';
import { InfoIcon } from '../lib/shared';
import { LoadingBlock } from './console-shared';

interface PersonRecord {
  source_id: string;
  slug: string;
  title: string;
  source_label: string;
  entity_id: string | null;
}

interface PersonSuggestion {
  left: PersonRecord;
  right: PersonRecord;
  reason: string;
}

interface PersonGroup {
  entity_id: string;
  name: string;
  members: PersonRecord[];
}

interface PersonCard {
  entity_id: string;
  name: string;
  company: string | null;
  role: string | null;
  last_contact: string | null;
  last_contact_label: string | null;
  open_items: number;
  recent_meetings: number;
  members: Array<PersonRecord & { canonical?: boolean }>;
  timeline: Array<{ date: string; summary: string; page_slug: string; event_slug: string | null }>;
}

function personKey(person: { source_id: string; slug: string }): string {
  return `${person.source_id}:${person.slug}`;
}

export function IdentityPage() {
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<PersonRecord[] | null>(null);
  const [suggestions, setSuggestions] = useState<PersonSuggestion[]>([]);
  const [groups, setGroups] = useState<PersonGroup[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [card, setCard] = useState<PersonCard | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async (search: string) => {
    try {
      const payload = await api.people(search) as {
        people?: PersonRecord[];
        suggestions?: PersonSuggestion[];
        groups?: PersonGroup[];
      };
      setPeople(payload.people ?? []);
      setSuggestions(payload.suggestions ?? []);
      setGroups(payload.groups ?? []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(''); }, [load]);

  const openCard = async (entityId: string) => {
    setBusy('card');
    try {
      setCard(await api.peopleCard(entityId) as PersonCard);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const toggle = (person: PersonRecord) => {
    const key = personKey(person);
    setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const mergeSelected = async (members?: PersonRecord[]) => {
    const chosen = members ?? (people ?? []).filter((person) => selected.includes(personKey(person)));
    if (chosen.length < 2) {
      setError('请至少勾选两条记录');
      return;
    }
    setBusy('merge');
    setNotice('');
    try {
      const result = await api.mergePeople(chosen.map((person) => ({
        source_id: person.source_id,
        slug: person.slug,
        title: person.title,
      }))) as { entity_id: string };
      setNotice('已把选中的记录视为同一个人');
      setSelected([]);
      await load(query);
      await openCard(result.entity_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const reject = async (item: PersonSuggestion) => {
    setBusy('reject');
    try {
      await api.rejectPeople({
        left: { source_id: item.left.source_id, slug: item.left.slug },
        right: { source_id: item.right.source_id, slug: item.right.slug },
      });
      await load(query);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const unlink = async (member: PersonRecord) => {
    if (!card) return;
    setBusy('unlink');
    try {
      await api.unlinkPeople({ entity_id: card.entity_id, source_id: member.source_id, slug: member.slug });
      await load(query);
      await openCard(card.entity_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  if (!people && !error) return <LoadingBlock text="正在读取人物关联…" />;

  return (
    <div className="pm-page daily-page">
      <div className="pm-section-head">
        <div>
          <h1 className="title-with-info">
            人物关联
            <InfoIcon title="人物关联">
              PMBrain 会提示可能是同一个人，但不会直接合并。确认后才会把不同来源的记录当成同一个人。
            </InfoIcon>
          </h1>
          <p className="pm-page-intro">搜索姓名，勾选后确认。自动判断都可以再改。</p>
        </div>
      </div>
      {error && <div className="pm-card pm-error">{error}</div>}
      {notice && <div className="pm-card pm-ok">{notice}</div>}

      {suggestions.length > 0 && (
        <div className="daily-stack">
          {suggestions.map((item) => (
            <article className="pm-card daily-card daily-suggest" key={`${personKey(item.left)}-${personKey(item.right)}`}>
              <b>{item.reason}</b>
              <p>{item.left.title}（{item.left.source_label}） ↔ {item.right.title}（{item.right.source_label}）</p>
              <div className="daily-loop-actions">
                <button type="button" className="pm-primary" disabled={busy === 'merge'} onClick={() => void mergeSelected([item.left, item.right])}>
                  确认关联
                </button>
                <button type="button" className="pm-ghost" disabled={busy === 'reject'} onClick={() => void reject(item)}>
                  不是同一个人
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <article className="pm-card daily-card">
        <header>
          <Users aria-hidden="true" />
          <div>
            <h2>搜索人物</h2>
            <p>例如：张三</p>
          </div>
        </header>
        <form className="daily-form" onSubmit={(event) => { event.preventDefault(); void load(query); }}>
          <label>
            搜索人物
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="张三" />
          </label>
          <button type="submit" className="pm-ghost">搜索</button>
        </form>
        <ul className="daily-check-list">
          {(people ?? []).map((person) => {
            const key = personKey(person);
            return (
              <li key={key}>
                <label className="daily-check">
                  <input type="checkbox" checked={selected.includes(key)} onChange={() => toggle(person)} />
                  {person.source_label} · {person.title}
                  {person.entity_id && <small>已关联</small>}
                </label>
              </li>
            );
          })}
        </ul>
        {(people ?? []).length === 0 && <p className="pm-hint">没有找到匹配的人物记录。</p>}
        <button type="button" className="pm-primary" disabled={busy === 'merge' || selected.length < 2} onClick={() => void mergeSelected()}>
          {busy === 'merge' ? '保存中…' : '把选中的记录视为同一个人'}
        </button>
      </article>

      {card && (
        <article className="pm-card daily-card daily-person-card">
          <h2>{card.name}</h2>
          <dl className="daily-person-facts">
            <div><dt>当前公司</dt><dd>{card.company || '暂无'}</dd></div>
            <div><dt>当前职位</dt><dd>{card.role || '暂无'}</dd></div>
            <div><dt>最近联系</dt><dd>{card.last_contact_label || '暂无'}</dd></div>
            <div><dt>未完成事项</dt><dd>{card.open_items}</dd></div>
            <div><dt>最近会议</dt><dd>{card.recent_meetings} 次</dd></div>
          </dl>
          <div>
            <h3>已关联记录</h3>
            <ul className="daily-loop-list">
              {card.members.map((member) => (
                <li key={personKey(member)}>
                  <div>{member.source_label} · {member.title}</div>
                  <button type="button" className="pm-ghost" disabled={busy === 'unlink'} onClick={() => void unlink(member)}>
                    取消关联
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>时间线</h3>
            {card.timeline.length === 0 ? <p className="pm-hint">还没有这个人的时间线。</p> : (
              <ul className="daily-loop-list">
                {card.timeline.map((row, index) => (
                  <li key={`${row.page_slug}-${row.date}-${index}`}>
                    <div>
                      <span className="daily-pill">{row.date.slice(0, 10)}</span>
                      <b>{row.summary}</b>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <a className="pm-ghost" href="#chronicle">查看全部</a>
          </div>
        </article>
      )}

      {groups.length > 0 && (
        <article className="pm-card daily-card">
          <h2>已确认的人物</h2>
          <ul className="daily-loop-list">
            {groups.map((group) => (
              <li key={group.entity_id}>
                <div>
                  <b>{group.name}</b>
                  <small>{group.members.map((member) => `${member.source_label} · ${member.title}`).join('、')}</small>
                </div>
                <button type="button" className="pm-ghost" onClick={() => void openCard(group.entity_id)}>打开人物卡</button>
              </li>
            ))}
          </ul>
        </article>
      )}
    </div>
  );
}
