/**
 * 产品经理能看懂的测试说明：
 * 1. 长文按当前字数上限读一段并记住读到哪里。同一上限、正文没变时不再重读；上限提高或正文变长才从上次位置继续。已经盖过“已读完”章的旧页面保持跳过。
 * 2. 同一小节里重复的事实表会合成一张，重复行去掉，前后正文保留。表格没写完且后面没有正文时才补上结束标记。解析会丢内容时整页不动。带原始文件路径的页面不改。
 * 3. 页面标记如果指向不存在的页面，或指向另一种类型且标题没有共同词，就去掉这个标记。同类型、标题有共同词、或就是自己的路径，都保留。
 * 4. 同一个人有两条任职关系时，只记下待确认提案，不改关系和页面。任职指向笔记、发件人不是人、或开关关闭时不调用模型。
 * 5. 没有固定问题时什么都不做。开关关闭时不把设置里的问题写进问题表。到期问题用注入的回答写答案和依据，不采用原子页或概念页。试运行不写库。
 * 6. 薄页补充在命令行没配置时保持关闭。产品深度整理传入“未设置则开启”后才会进入补充；设置里明确关闭时两边都关闭。第一次非试运行的深度整理只在空值时记下开启，并包含项目类型。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DreamSettingsResponseSchema } from '../shared/contracts/dream.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { renderTakesFence, type ParsedTake } from '../src/core/takes-fence.ts';
import {
  atomTextHash16,
  partialAtomSourceHash,
  planAtomWindow,
  resolveExtractAtomsInputCap,
  utf8SafeEnd,
} from '../src/core/cycle/extract-atoms-window.ts';
import { countExtractAtomsBacklog, discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';
import {
  recordTranscriptPartial,
  skippedTranscriptKeys,
  stampTranscriptTombstone,
  tombstonedTranscriptsForHashes,
  transcriptStateKey,
} from '../src/core/cycle/extract-atoms-transcript-state.ts';
import { repairFenceBody, runPhaseContentRepair, runPhaseFenceRepair, straySlugAction, titlesShare } from '../src/core/cycle/maintenance-repair.ts';
import { runPhaseEdgeContradictions } from '../src/core/cycle/edge-contradictions.ts';
import { parseStandingQuestionLines, runPhaseStandingQuestions } from '../src/core/cycle/standing-questions.ts';
import { enrichThinTypesFromConfig, runPhaseEnrichThin } from '../src/core/cycle/enrich-thin.ts';
import { prepareProductEnrichThin } from '../src/product/tasks/dream-knowledge.ts';
import { ALL_PHASES, DEFAULT_PHASES, SOURCE_FRESHNESS_PHASES } from '../src/core/cycle.ts';
import { resolveDreamPresetPhases } from '../src/commands/dream.ts';
import { resolveQuickMaintenancePhases } from '../src/core/quick-maintenance.ts';
import type { PageType } from '../src/core/types.ts';

function fact(rowNum: number, claim: string): ParsedFact {
  return {
    rowNum,
    claim,
    kind: 'fact',
    confidence: 1,
    visibility: 'world',
    notability: 'medium',
    validFrom: '2026-01-01',
    active: true,
  };
}

function take(rowNum: number, claim: string): ParsedTake {
  return { rowNum, claim, kind: 'take', holder: 'world', weight: 0.6, active: true };
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function put(slug: string, type: PageType, title: string, body: string, frontmatter: Record<string, unknown> = {}, sourcePath?: string): Promise<void> {
  await engine.putPage(slug, {
    type,
    title,
    compiled_truth: body,
    timeline: '',
    frontmatter,
    ...(sourcePath ? { source_path: sourcePath } : {}),
  });
}

async function readPage(slug: string): Promise<{ compiled_truth: string; frontmatter: Record<string, unknown>; source_path: string | null; content_hash: string }> {
  const rows = await engine.executeRaw<{ compiled_truth: string; frontmatter: Record<string, unknown> | string; source_path: string | null; content_hash: string }>(
    `SELECT compiled_truth, frontmatter, source_path, content_hash FROM pages WHERE slug = $1 AND deleted_at IS NULL`,
    [slug],
  );
  const row = rows[0]!;
  const frontmatter = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) as Record<string, unknown> : row.frontmatter;
  return { compiled_truth: row.compiled_truth, frontmatter, source_path: row.source_path, content_hash: row.content_hash };
}

async function pageId(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  return Number(rows[0]!.id);
}

describe('整理阶段怎么排进快速维护和深度整理', () => {
  test('事实栏和页面标记紧跟同步，关系矛盾和固定问题夹在漂移两侧，新鲜度检查不带上它们', () => {
    expect(ALL_PHASES).toHaveLength(27);
    expect(ALL_PHASES.indexOf('content_repair')).toBe(ALL_PHASES.indexOf('sync') + 2);
    expect(ALL_PHASES.indexOf('fence_repair')).toBe(ALL_PHASES.indexOf('sync') + 1);
    expect(ALL_PHASES.indexOf('content_repair')).toBeLessThan(ALL_PHASES.indexOf('synthesize'));
    expect(ALL_PHASES.indexOf('edge_contradictions')).toBe(ALL_PHASES.indexOf('drift') - 1);
    expect(ALL_PHASES.indexOf('standing_questions')).toBe(ALL_PHASES.indexOf('drift') + 1);
    expect(ALL_PHASES.indexOf('capture_entities')).toBeLessThan(ALL_PHASES.indexOf('enrich_thin'));
    expect(DEFAULT_PHASES).toContain('fence_repair');
    expect(DEFAULT_PHASES).toContain('standing_questions');
    expect(resolveQuickMaintenancePhases()).toEqual(resolveDreamPresetPhases('quick'));
    expect(resolveQuickMaintenancePhases()).toContain('fence_repair');
    expect(resolveQuickMaintenancePhases()).toContain('content_repair');
    expect(resolveQuickMaintenancePhases()).not.toContain('edge_contradictions');
    expect(resolveQuickMaintenancePhases()).not.toContain('standing_questions');
    expect(resolveQuickMaintenancePhases()).not.toContain('enrich_thin');
    expect(resolveDreamPresetPhases('meeting')).not.toContain('fence_repair');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('fence_repair');
    expect(SOURCE_FRESHNESS_PHASES).not.toContain('edge_contradictions');
  });

  test('设置契约接收四项维护字段，关系矛盾开关只写入提案模式', async () => {
    const parsed = DreamSettingsResponseSchema.parse({
      outputDir: 'output',
      dualWrite: true,
      includeUncommitted: false,
      defaultBrainDir: null,
      resolvedOutputDir: null,
      directoryExists: false,
      enrichThinEnabled: true,
      fenceRepairEnabled: false,
      edgeContradictionsEnabled: true,
      standingQuestions: '这个项目下一步是什么',
    });
    expect(parsed.enrichThinEnabled).toBe(true);
    expect(parsed.fenceRepairEnabled).toBe(false);
    expect(parsed.standingQuestions).toBe('这个项目下一步是什么');
    expect(parseStandingQuestionLines('')).toEqual([]);
    expect(parseStandingQuestionLines('甲\n乙')).toEqual(['甲', '乙']);
    expect(parseStandingQuestionLines(Array.from({ length: 21 }, (_, index) => `问题${index}`).join('\n'))).toBeNull();
    expect(parseStandingQuestionLines('甲'.repeat(201))).toBeNull();
    const routes = await Bun.file(new URL('../src/commands/pmbrain-admin-routes.ts', import.meta.url)).text();
    expect(routes).toContain("edgeContradictionsEnabled?'propose':'off'");
    expect(routes).not.toContain("edgeContradictionsEnabled?'apply'");
    const worker = await Bun.file(new URL('../src/product/tasks/task-worker.ts', import.meta.url)).text();
    expect(worker).toContain("input.preset==='full'&&!input.dryRun");
    expect(worker).toContain('prepareProductEnrichThin');
    expect(worker).toContain('enrichThinWhenUnset:true');
  });
});

describe('长文只记住读到哪里', () => {
  test('同一上限不逐窗重读；上限提高或正文接长后从上次位置继续，开头变了才从头再来', () => {
    const content = '甲'.repeat(1200);
    const first = planAtomWindow(content, 1000, null);
    expect(first.truncated).toBe(true);
    expect(first.readStart).toBe(0);
    expect(first.complete).toBe(false);
    const same = planAtomWindow(content, 1000, { readChars: first.readEnd, prefixHash: atomTextHash16(content.slice(0, first.readEnd)) });
    expect(same.readStart).toBe(first.readEnd);
    expect(same.promptContent.length).toBe(200);
    expect(same.restart).toBe(false);
    const appended = planAtomWindow(content + '乙'.repeat(50), 1000, { readChars: first.readEnd, prefixHash: atomTextHash16(content.slice(0, first.readEnd)) });
    expect(appended.readStart).toBe(first.readEnd);
    expect(appended.restart).toBe(false);
    const restarted = planAtomWindow('乙' + content.slice(1), 1000, { readChars: first.readEnd, prefixHash: atomTextHash16(content.slice(0, first.readEnd)) });
    expect(restarted.restart).toBe(true);
    expect(restarted.readStart).toBe(0);
    expect(partialAtomSourceHash('0123456789abcdef', true, first.readStart)).toBe('0123456789abcdef:w0');
    expect(partialAtomSourceHash('0123456789abcdef', false, 0)).toBe('0123456789abcdef');
    const emoji = '😀';
    expect(utf8SafeEnd(`ab${emoji}cd`, 3)).toBe(2);
    const bumped = planAtomWindow(emoji, 1, null);
    expect(bumped.readEnd).toBe(1);
    expect(bumped.promptContent.length).toBe(1);
  });

  test('数据库里的长文在同一上限下第二次不再被发现，提高上限后从水位继续；旧的已读完标记仍然跳过', async () => {
    const content = '甲'.repeat(1200);
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '1000');
    expect(await resolveExtractAtomsInputCap(engine)).toBe(1000);
    await put('articles/long-source', 'article', '长文', content);
    const found = await discoverExtractablePages(engine, 'default');
    expect(found.map(page => page.slug)).toContain('articles/long-source');
    const stored = await readPage('articles/long-source');
    const plan = planAtomWindow(content, 1000, null);
    const hash16 = stored.content_hash.slice(0, 16);
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object(
         'atoms_read_chars', $1::int,
         'atoms_read_prefix_hash', $2::text,
         'atoms_window_hash', $3::text,
         'atoms_partial_cap', $4::int
       ) WHERE slug = $5`,
      [plan.readEnd, atomTextHash16(content.slice(0, plan.readEnd)), hash16, 1000, 'articles/long-source'],
    );
    expect((await discoverExtractablePages(engine, 'default')).some(page => page.slug === 'articles/long-source')).toBe(false);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '2000');
    const continued = (await discoverExtractablePages(engine, 'default')).find(page => page.slug === 'articles/long-source');
    expect(continued?.prior?.readChars).toBe(plan.readEnd);
    const next = planAtomWindow(content, 2000, continued?.prior ?? null);
    expect(next.readStart).toBe(plan.readEnd);
    expect(next.restart).toBe(false);

    const legacy = '乙'.repeat(800);
    await put('articles/legacy-stamped', 'article', '旧长文', legacy);
    const legacyRow = await readPage('articles/legacy-stamped');
    await engine.executeRaw(
      `UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('atoms_scan_hash', $1::text) WHERE slug = $2`,
      [legacyRow.content_hash.slice(0, 16), 'articles/legacy-stamped'],
    );
    expect((await discoverExtractablePages(engine, 'default')).some(page => page.slug === 'articles/legacy-stamped')).toBe(false);
  }, 60_000);

  test('对话摘录被截断时记下已读字数，同一上限跳过，提高上限后再读；读完的墓碑仍然有效', async () => {
    const hash = 'a'.repeat(64);
    await recordTranscriptPartial(engine, 'default', 'notes/talk.md', hash, 1000);
    const key = transcriptStateKey('notes/talk.md', hash.slice(0, 16));
    expect((await skippedTranscriptKeys(engine, 'default', [hash.slice(0, 16)], 1000)).has(key)).toBe(true);
    expect((await skippedTranscriptKeys(engine, 'default', [hash.slice(0, 16)], 2000)).has(key)).toBe(false);
    await stampTranscriptTombstone(engine, 'default', 'notes/done.md', 'b'.repeat(64));
    const tomb = transcriptStateKey('notes/done.md', 'b'.repeat(16));
    expect((await tombstonedTranscriptsForHashes(engine, 'default', ['b'.repeat(16)])).has(tomb)).toBe(true);
    await recordTranscriptPartial(engine, 'default', 'notes/done.md', 'b'.repeat(64), 1000);
    expect((await skippedTranscriptKeys(engine, 'default', ['b'.repeat(16)], 5000)).has(tomb)).toBe(true);
  }, 60_000);
});

describe('事实栏、页面标记和原始文件', () => {
  test('重复事实表合成一张并保留正文；干净的一张表不动；坏表和后面还有正文的半截表整页不动', () => {
    const first = renderFactsTable([fact(1, '同一件事'), fact(2, '另一件事')]);
    const second = renderFactsTable([fact(1, '第三件事'), fact(2, '同一件事')]);
    const body = `## 事实\n${first}\n\n中间说明\n\n${second}\n\n结尾说明`;
    const merged = repairFenceBody(body);
    expect(merged.refused).toBe(false);
    expect(merged.merged).toBe(1);
    expect(merged.body.split(FACTS_FENCE_BEGIN)).toHaveLength(2);
    expect(merged.body).toContain('同一件事');
    expect(merged.body).toContain('另一件事');
    expect(merged.body).toContain('第三件事');
    expect(merged.body).toContain('中间说明');
    expect(merged.body).toContain('结尾说明');
    expect(merged.body.split('同一件事')).toHaveLength(2);
    const clean = renderFactsTable([fact(1, '只有一件事')]);
    expect(repairFenceBody(clean)).toEqual({ body: clean, changed: false, merged: 0, closed: 0, refused: false });
    const open = renderFactsTable([fact(1, '一件事')]).replace(FACTS_FENCE_END, '');
    const withProse = `${open}后面的正文不应该被吃掉`;
    expect(repairFenceBody(withProse).changed).toBe(false);
    expect(repairFenceBody(withProse).body).toBe(withProse);
    const closed = repairFenceBody(`## 事实\n${open}`);
    expect(closed.closed).toBe(1);
    expect(closed.body).toContain(FACTS_FENCE_END);
    expect(closed.body).toContain('一件事');
    const bad = `${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 坏掉的 | nope | 1.0 | world | medium | 2026-01-01 |  |  |  |\n${FACTS_FENCE_END}`;
    const refusedBody = `## 事实\n${clean}\n${bad}`;
    const refused = repairFenceBody(refusedBody);
    expect(refused.refused).toBe(true);
    expect(refused.body).toBe(refusedBody);
    const takes = `## 观点\n${renderTakesFence([take(1, '同一个判断')])}\n${renderTakesFence([take(1, '另一个判断'), take(2, '同一个判断')])}`;
    const takeRepair = repairFenceBody(takes);
    expect(takeRepair.refused).toBe(false);
    expect(takeRepair.body).toContain('另一个判断');
    expect(takeRepair.body.split('同一个判断')).toHaveLength(2);
  });

  test('指错的页面标记按类型和标题决定去留', () => {
    expect(titlesShare('出海 纪要', '出海 计划')).toBe(true);
    expect(titlesShare('会议纪要', '预算表')).toBe(false);
    expect(straySlugAction('notes/self', { slug: 'notes/self', type: 'note', title: '自己' }, null)).toBe('keep');
    expect(straySlugAction('projects/missing', { slug: 'notes/a', type: 'note', title: '纪要' }, null)).toBe('remove');
    expect(straySlugAction('notes/b', { slug: 'notes/a', type: 'note', title: '会议纪要' }, { type: 'note', title: '预算表' })).toBe('keep');
    expect(straySlugAction('projects/budget', { slug: 'notes/a', type: 'note', title: '会议纪要' }, { type: 'project', title: '预算表' })).toBe('remove');
    expect(straySlugAction('projects/sea', { slug: 'notes/a', type: 'note', title: '出海 纪要' }, { type: 'project', title: '出海 计划' })).toBe('keep');
  });

  test('数据库里合并事实栏，试运行和原始文件都不改页面', async () => {
    const body = `## 事实\n${renderFactsTable([fact(1, '同一件事')])}\n${renderFactsTable([fact(1, '另一件事')])}`;
    await put('notes/facts', 'note', '事实页', body);
    const dry = await runPhaseFenceRepair(engine, { dryRun: true });
    expect(dry.details.written).toBe(1);
    expect((await readPage('notes/facts')).compiled_truth).toBe(body);
    expect(await engine.getConfig('fences.repair.cursor_id')).toBeNull();
    const written = await runPhaseFenceRepair(engine, {});
    expect(written.details.written).toBe(1);
    const saved = await readPage('notes/facts');
    expect(saved.compiled_truth.split(FACTS_FENCE_BEGIN)).toHaveLength(2);
    expect(saved.compiled_truth).toContain('另一件事');
    expect(await engine.getConfig('fences.repair.cursor_id')).toBe('0');
    const again = await readPage('notes/facts');
    await runPhaseFenceRepair(engine, {});
    expect((await readPage('notes/facts')).compiled_truth).toBe(again.compiled_truth);

    const fileBody = `## 事实\n${renderFactsTable([fact(1, '文件里的事')])}\n${renderFactsTable([fact(1, '另一件文件里的事')])}`;
    await put('notes/file-facts', 'note', '原始事实', fileBody, {}, 'D:/raw/original.md');
    const fileResult = await runPhaseFenceRepair(engine, {});
    expect(fileResult.details.file_backed).toBe(1);
    expect((await readPage('notes/file-facts')).compiled_truth).toBe(fileBody);

    const bad = `${FACTS_FENCE_BEGIN}\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | 坏掉的 | nope | 1.0 | world | medium | 2026-01-01 |  |  |  |\n${FACTS_FENCE_END}`;
    const refusedBody = `## 事实\n${bad}`;
    await put('notes/bad-facts', 'note', '坏表', refusedBody);
    const refused = await runPhaseFenceRepair(engine, {});
    expect(refused.status).toBe('warn');
    expect((await readPage('notes/bad-facts')).compiled_truth).toBe(refusedBody);
  }, 60_000);

  test('数据库里去掉指错的标记，同类型和有共同词的标记留下，原始文件不动', async () => {
    await put('notes/stray', 'note', '会议纪要', '正文', { slug: 'projects/missing', note: 'keep-me' });
    await put('notes/same-type', 'note', '会议纪要', '正文', { slug: 'notes/other' });
    await put('notes/other', 'note', '预算表', '另一篇');
    await put('notes/shared', 'note', '出海 纪要', '正文', { slug: 'projects/sea' });
    await put('projects/sea', 'project', '出海 计划', '项目');
    await put('notes/file-slug', 'note', '原始标记', '正文', { slug: 'projects/missing-file' }, 'D:/raw/original.md');
    const dry = await runPhaseContentRepair(engine, { dryRun: true });
    expect(Number(dry.details.removed)).toBeGreaterThan(0);
    expect((await readPage('notes/stray')).frontmatter.slug).toBe('projects/missing');
    expect(await engine.getConfig('fences.repair.slug_cursor_id')).toBeNull();
    await runPhaseContentRepair(engine, {});
    const stray = await readPage('notes/stray');
    expect(stray.frontmatter.slug).toBeUndefined();
    expect(stray.frontmatter.note).toBe('keep-me');
    expect((await readPage('notes/same-type')).frontmatter.slug).toBe('notes/other');
    expect((await readPage('notes/shared')).frontmatter.slug).toBe('projects/sea');
    expect((await readPage('notes/file-slug')).frontmatter.slug).toBe('projects/missing-file');
    expect((await readPage('notes/file-slug')).compiled_truth).toBe('正文');
  }, 60_000);
});

describe('关系矛盾只提案', () => {
  async function seedEdges(): Promise<void> {
    await put('people/li', 'person', '李明', '李明的介绍');
    await put('companies/jia', 'company', '甲公司', '甲公司介绍');
    await put('companies/yi', 'company', '乙公司', '乙公司介绍');
    await put('notes/mail', 'note', '一封邮件', '邮件正文');
    await put('companies/bing', 'company', '丙公司', '丙公司介绍');
    const person = await pageId('people/li');
    const jia = await pageId('companies/jia');
    const yi = await pageId('companies/yi');
    const note = await pageId('notes/mail');
    const bing = await pageId('companies/bing');
    for (const target of [jia, yi, note]) {
      await engine.executeRaw(
        `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'works_at', 'manual')`,
        [person, target],
      );
    }
    await engine.executeRaw(
      `INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, 'works_at', 'manual'), ($1, $3, 'works_at', 'manual')`,
      [jia, yi, bing],
    );
  }

  async function linkCount(): Promise<number> {
    const rows = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM links`);
    return Number(rows[0]!.n);
  }

  test('试运行只计数，不调用模型，也不写提案', async () => {
    await seedEdges();
    let calls = 0;
    const before = await linkCount();
    const result = await runPhaseEdgeContradictions(engine, { dryRun: true, judge: async () => { calls += 1; return '{"choice":"a","reason":"不该被调用"}'; } });
    expect(calls).toBe(0);
    expect(result.details.proposed).toBe(1);
    expect(await linkCount()).toBe(before);
    expect((await engine.executeRaw(`SELECT id FROM link_edge_proposals`)).length).toBe(0);
    expect((await readPage('people/li')).compiled_truth).toBe('李明的介绍');
  }, 60_000);

  test('正式运行只新增提案，关系和页面保持原样；关闭或要求自动改写时也不改关系', async () => {
    await seedEdges();
    const before = await linkCount();
    const body = (await readPage('people/li')).compiled_truth;
    let calls = 0;
    const result = await runPhaseEdgeContradictions(engine, {
      judge: async () => { calls += 1; return '{"choice":"a","reason":"甲公司有更多页面"}'; },
    });
    expect(calls).toBe(1);
    expect(result.details.proposed).toBe(1);
    expect(await linkCount()).toBe(before);
    expect((await readPage('people/li')).compiled_truth).toBe(body);
    const proposals = await engine.executeRaw<{ status: string }>(`SELECT status FROM link_edge_proposals`);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('proposed');
    const second = await runPhaseEdgeContradictions(engine, { judge: async () => { calls += 1; return '{"choice":"b","reason":"重复"}'; } });
    expect(second.details.proposed).toBe(0);
    expect(calls).toBe(1);
    await engine.setConfig('dream.edge_contradictions.mode', 'apply');
    const apply = await runPhaseEdgeContradictions(engine, { judge: async () => { calls += 1; return '{"choice":"a","reason":"仍只提案"}'; } });
    expect(apply.details.apply_not_ported).toBe(true);
    expect(await linkCount()).toBe(before);
    expect((await engine.executeRaw(`SELECT id FROM link_edge_proposals`)).length).toBe(1);
    await engine.setConfig('dream.edge_contradictions.mode', 'off');
    const off = await runPhaseEdgeContradictions(engine, { judge: async () => { calls += 1; return '{"choice":"a"}'; } });
    expect(off.details.reason).toBe('disabled');
    expect(calls).toBe(1);
  }, 60_000);
});

describe('固定问题', () => {
  test('没有问题或开关关闭时不调用回答，也不写入问题', async () => {
    let calls = 0;
    const empty = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; return '不该回答'; } });
    expect(empty.details.reason).toBe('no_pins');
    expect(calls).toBe(0);
    await engine.setConfig('cycle.standing_questions.enabled', 'false');
    await engine.setConfig('cycle.standing_questions.questions', JSON.stringify(['出海项目进展']));
    const disabled = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; return '不该回答'; } });
    expect(disabled.details.reason).toBe('disabled');
    expect(calls).toBe(0);
    expect((await engine.executeRaw(`SELECT id FROM pinned_questions`)).length).toBe(0);
    await engine.unsetConfig('cycle.standing_questions.enabled');
    await engine.executeRaw(
      `INSERT INTO pinned_questions (source_id, question, state, origin) VALUES ('default', '手工留下的问题', 'active', 'pin')`,
    );
    const synced = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; return '现有页面没有足够依据'; } });
    expect(synced.details.refreshed).toBe(2);
    expect(calls).toBe(2);
    await engine.setConfig('cycle.standing_questions.questions', '[]');
    const cleared = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; return '不该再回答'; } });
    expect(cleared.details.reason).toBe('cooldown');
    const pins = await engine.executeRaw<{ question: string; origin: string; state: string }>(
      `SELECT question, origin, state FROM pinned_questions ORDER BY question`,
    );
    expect(pins).toEqual([
      { question: '出海项目进展', origin: 'config', state: 'inactive' },
      { question: '手工留下的问题', origin: 'pin', state: 'active' },
    ]);
    expect(calls).toBe(2);
  }, 60_000);

  test('到期问题写入答案和页面依据，不采用原子页或概念页；试运行不写', async () => {
    await put('projects/sea', 'project', '出海项目进展', '项目正在推进');
    await put('atoms/sea', 'atom', '出海项目进展', '这是原子页');
    await put('concepts/sea', 'concept', '出海项目进展', '这是概念页');
    await engine.executeRaw(
      `INSERT INTO pinned_questions (source_id, question, state, origin) VALUES ('default', '出海项目进展', 'active', 'pin')`,
    );
    let calls = 0;
    const dry = await runPhaseStandingQuestions(engine, { dryRun: true, answer: async () => { calls += 1; return '试运行不该写'; } });
    expect(dry.details.reason).toBe('dry_run');
    expect(calls).toBe(0);
    const pending = await engine.executeRaw<{ answer: string | null }>(`SELECT answer FROM pinned_questions`);
    expect(pending[0]!.answer).toBeNull();
    const answered = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; return '根据项目页，项目正在推进'; } });
    expect(calls).toBe(1);
    expect(answered.details.refreshed).toBe(1);
    const rows = await engine.executeRaw<{ answer: string; slug: string }>(
      `SELECT q.answer, e.slug FROM pinned_questions q LEFT JOIN question_evidence e ON e.question_id = q.id`,
    );
    expect(rows.map(row => row.answer)).toContain('根据项目页，项目正在推进');
    expect(rows.map(row => row.slug)).toContain('projects/sea');
    expect(rows.map(row => row.slug)).not.toContain('atoms/sea');
    expect(rows.map(row => row.slug)).not.toContain('concepts/sea');
  }, 60_000);

  test('回答失败只记下尝试时间，冷却未到之前不反复调用', async () => {
    await engine.executeRaw(
      `INSERT INTO pinned_questions (source_id, question, state, origin) VALUES ('default', '谁在负责', 'active', 'pin')`,
    );
    let calls = 0;
    const failed = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; throw new Error('模型暂时失败'); } });
    expect(failed.details.failed).toBe(1);
    const row = (await engine.executeRaw<{ last_refresh_at: string | null; last_error: string | null }>(
      `SELECT last_refresh_at, last_error FROM pinned_questions`,
    ))[0]!;
    expect(row.last_refresh_at).toBeNull();
    expect(row.last_error).toContain('模型暂时失败');
    const cooled = await runPhaseStandingQuestions(engine, { answer: async () => { calls += 1; return '不该再问'; } });
    expect(cooled.details.reason).toBe('cooldown');
    expect(calls).toBe(1);
  }, 60_000);
});

describe('薄页补充的开关', () => {
  test('命令行默认关闭；产品未设置则开启；明确关闭后不再开启', async () => {
    expect(enrichThinTypesFromConfig(null)).toEqual(['person', 'company']);
    expect(enrichThinTypesFromConfig(null, ['person', 'company', 'project'])).toContain('project');
    expect(enrichThinTypesFromConfig(JSON.stringify(['person']))).toEqual(['person']);
    const off = await runPhaseEnrichThin(engine, {});
    expect(off.details.reason).toBe('disabled');
    const flagged = await runPhaseEnrichThin(engine, { enabledWhenUnset: true, typesWhenUnset: ['person', 'company', 'project'] });
    expect(flagged.details.reason).not.toBe('disabled');
    if (flagged.status === 'skipped') expect(flagged.details.reason).toBe('no_chat_gateway');
    else expect(flagged.details.types).toEqual(['person', 'company', 'project']);
    await engine.setConfig('cycle.enrich_thin.enabled', 'false');
    const forced = await runPhaseEnrichThin(engine, { enabledWhenUnset: true });
    expect(forced.details.reason).toBe('disabled');
    await engine.unsetConfig('cycle.enrich_thin.enabled');
    await prepareProductEnrichThin(engine);
    expect(await engine.getConfig('cycle.enrich_thin.enabled')).toBe('true');
    expect(JSON.parse(await engine.getConfig('cycle.enrich_thin.types') ?? '[]')).toContain('project');
    await engine.setConfig('cycle.enrich_thin.enabled', 'false');
    await engine.setConfig('cycle.enrich_thin.types', JSON.stringify(['person']));
    await prepareProductEnrichThin(engine);
    expect(await engine.getConfig('cycle.enrich_thin.enabled')).toBe('false');
    expect(await engine.getConfig('cycle.enrich_thin.types')).toBe(JSON.stringify(['person']));
  }, 60_000);
});
