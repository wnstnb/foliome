import { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { WIKI_TYPE_LABELS, WIKI_STATUS_COLORS } from '@/lib/constants';
import { MarkdownRenderer } from '@/components/shared/MarkdownRenderer';
import { showBackButton, hideBackButton } from '@/lib/telegram';
import { ChevronLeft, ChevronRight, Search, Check } from 'lucide-react';
import type { WikiIndexData, WikiPageData, WikiPageMeta } from '@/lib/types';

// The wiki answers "what do we currently believe, and on what evidence?" (docs/wiki.md).
type View = { name: 'home' } | { name: 'kind'; kind: string } | { name: 'page'; path: string } | { name: 'all' };

const CURRENT = new Set(['standing', 'active']);
const KIND_ORDER = ['goal', 'decision', 'finding', 'context', 'reflection', 'source'];
const SOURCE_BADGES: Record<string, string> = { tweet: 'Tweet', article: 'Article', video: 'Video', pdf: 'PDF' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d: string) => { const [, m, dd] = (d || '').split('-'); return dd ? `${MON[+m - 1]} ${+dd}` : d; };
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function StatusPill({ status }: { status: string }) {
  if (!status) return null;
  const color = WIKI_STATUS_COLORS[status] || 'var(--text-muted)';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {titleCase(status)}
    </span>
  );
}

function Back({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      className="flex items-center gap-1 min-h-[44px] text-[var(--brand)] bg-transparent border-none cursor-pointer p-0 t-body"
      onClick={onClick}
    >
      <ChevronLeft className="w-4 h-4" />
      {label}
    </button>
  );
}

function SectionHead({ title, aside, onAside }: { title: string; aside?: string; onAside?: () => void }) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h2 className="t-body font-semibold text-[var(--text)]">{title}</h2>
      {aside && (onAside
        ? <button className="text-[12px] leading-snug text-[var(--brand)] bg-transparent border-none cursor-pointer p-0" onClick={onAside}>{aside}</button>
        : <span className="text-[12px] leading-snug text-[var(--text-muted)]">{aside}</span>)}
    </div>
  );
}

const card = 'bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px]';
const rowBtn = 'w-full text-left bg-transparent border-none cursor-pointer';

export function Wiki() {
  const [index, setIndex] = useState<WikiIndexData | null>(null);
  const [page, setPage] = useState<WikiPageData | null>(null);
  const [stack, setStack] = useState<View[]>([{ name: 'home' }]);
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = stack[stack.length - 1];

  useEffect(() => {
    fetchWithAuth<WikiIndexData>('/api/wiki').then(setIndex).catch(e => setError(e.message));
  }, []);

  useEffect(() => {
    if (view.name !== 'page') { setPage(null); return; }
    setPage(null);
    fetchWithAuth<WikiPageData>('/api/wiki/page', { path: view.path })
      .then(setPage)
      .catch(e => { setError(e.message); setStack(s => s.slice(0, -1)); });
  }, [view]);

  const go = useCallback((v: View) => { setStack(s => [...s, v]); setTopic(null); window.scrollTo?.(0, 0); }, []);
  const back = useCallback(() => { setStack(s => (s.length > 1 ? s.slice(0, -1) : s)); window.scrollTo?.(0, 0); }, []);
  const openPath = useCallback((path: string) => go({ name: 'page', path }), [go]);

  useEffect(() => {
    if (stack.length <= 1) return;
    showBackButton(back);
    return () => hideBackButton(back);
  }, [stack.length, back]);

  const all = useMemo(() => (index ? index.groups.flatMap(g => g.pages) : []), [index]);
  const bySlug = useMemo(() => new Map(all.map(p => [p.slug, p])), [all]);

  if (error && !index) return <div className="py-12 text-center"><p className="t-body text-[var(--text-muted)]">{error}</p></div>;
  if (!index) return <WikiSkeleton />;

  if (index.totalPages === 0) {
    return (
      <div className="animate-fade-in py-16 text-center px-6">
        <p className="t-value text-[var(--text)] mb-2">No wiki pages yet</p>
        <p className="t-body text-[var(--text-muted)] leading-relaxed">
          Goals, decisions and what the agent learns about your money will appear here as they come up in conversation.
        </p>
      </div>
    );
  }

  // ── Page view ──────────────────────────────────────────────────────────────
  if (view.name === 'page') {
    const prev = stack[stack.length - 2];
    const backLabel = prev?.name === 'kind' ? WIKI_TYPE_LABELS[prev.kind] || 'Back' : prev?.name === 'all' ? 'All pages' : prev?.name === 'page' ? 'Back' : 'Wiki';
    if (!page) return <div className="animate-fade-in"><Back label={backLabel} onClick={back} /><PageSkeleton /></div>;
    const m = page.meta;
    // Body for reading: wikilinks become page links, machine markers go, and the title and lead
    // (shown above in the answer box) aren't repeated.
    let body = page.body
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_s, slug: string, label?: string) => {
        const t = bySlug.get(slug.trim().split('/').pop() || '');
        return t ? `[${label || t.short || t.title}](${t.path}.md)` : (label || slug);
      });
    body = body.replace(/^#\s+.+\n+/, '');
    const firstPara = body.split(/\n\s*\n/)[0] || '';
    if (m.lead && firstPara.replace(/[*_`[\]]/g, '').trim().startsWith(m.lead.slice(0, 40))) body = body.slice(firstPara.length).trim();
    const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map(x => x[1].trim());
    const jump = headings.length >= 2 && headings.length <= 6 ? headings : [];
    const label = (h: string) => h.replace(/[^\p{L}\p{N}\s.,:'’()$%-]/gu, '').replace(/\s+/g, ' ').trim();
    const slugId = (h: string) => 'h-' + h.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const dirLabel = { both: '⇄ both ways', out: '→ links out only', in: '← links here only' };

    return (
      <div className="animate-fade-in md:max-w-[680px] flex flex-col gap-3.5">
        <Back label={backLabel} onClick={back} />
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={m.status} />
          <span className="text-[12px] leading-snug text-[var(--text-muted)]">
            {(WIKI_TYPE_LABELS[m.type] || m.type).replace(/s$/, '')}{m.updated ? ` · updated ${shortDate(m.updated)}` : ''}{m.created ? ` · created ${shortDate(m.created)}` : ''}
          </span>
          {m.source_type && SOURCE_BADGES[m.source_type] && <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--border)]/50 text-[var(--text-muted)]">{SOURCE_BADGES[m.source_type]}</span>}
        </div>
        <h1 className="text-[22px] font-bold leading-tight text-[var(--text)] -mt-1">{page.title}</h1>

        {page.supersededBy && (
          <div className={`${card} p-3 t-body`} style={{ borderColor: 'var(--warning)' }}>
            {m.status === 'refuted' ? 'Shown to be wrong.' : 'No longer current.'} Read{' '}
            <button className="text-[var(--brand)] bg-transparent border-none p-0 cursor-pointer underline" onClick={() => openPath(page.supersededBy!.path)}>{page.supersededBy.title}</button> instead.
          </div>
        )}
        {!page.supersededBy && !CURRENT.has(m.status) && m.status && (
          <div className={`${card} p-3 text-[12px] leading-snug text-[var(--text-muted)]`}>This page is {m.status}. Kept for the record; don't quote it as current.</div>
        )}

        {(m.lead || m.headline) && (
          <div className="rounded-[14px] p-3.5 flex flex-col gap-1.5" style={{ background: 'color-mix(in srgb, var(--brand) 14%, var(--bg-card))', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
            <span className="text-[11px] font-semibold tracking-wider uppercase text-[var(--brand-light)]">The answer</span>
            {m.headline && <span className="text-[24px] font-bold tabular-nums text-[var(--text)]">{m.headline}</span>}
            {m.lead && <span className="t-body text-[var(--text)]">{m.lead}</span>}
          </div>
        )}

        {(jump.length > 0 || page.related.length > 0) && (
          <nav aria-label="On this page" className="flex flex-wrap gap-1.5">
            {jump.map(h => (
              <a key={h} href={`#${slugId(h)}`} className="min-h-[32px] inline-flex items-center px-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[12px] leading-snug text-[var(--text)] no-underline">{label(h)}</a>
            ))}
            {page.related.length > 0 && <a href="#h-related-panel" className="min-h-[32px] inline-flex items-center px-2.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[12px] leading-snug text-[var(--text)] no-underline">Related {page.related.length}</a>}
          </nav>
        )}

        <div className="wiki-body">
          {body.split(/(?=^##\s)/m).map((chunk, i) => {
            const h = chunk.match(/^##\s+(.+)$/m);
            return <div key={i} id={h ? slugId(h[1].trim()) : undefined}><MarkdownRenderer content={chunk} onNavigate={openPath} /></div>;
          })}
        </div>

        {page.related.length > 0 && (
          <section id="h-related-panel" className={`${card} p-3 flex flex-col`}>
            <div className="flex items-baseline justify-between mb-1">
              <h2 className="t-body font-semibold">Related</h2>
              <span className="text-[12px] leading-snug text-[var(--text-muted)]">links out and links here</span>
            </div>
            {page.related.map(r => (
              <button key={r.path} className={`${rowBtn} min-h-[44px] flex items-center justify-between gap-2 border-t border-[var(--border)] t-body text-[var(--text)] px-0`} onClick={() => openPath(r.path)}>
                <span className={CURRENT.has(r.status) || !r.status ? '' : 'line-through text-[var(--text-muted)]'}>{r.title}</span>
                <span className="text-[12px] leading-snug shrink-0" style={{ color: r.direction === 'both' ? 'var(--text-muted)' : 'var(--warning)' }}>{dirLabel[r.direction]}</span>
              </button>
            ))}
          </section>
        )}

        {(m.tags.length > 0 || m.sources.length > 0 || m.source_url) && (
          <div className="text-[12px] leading-snug text-[var(--text-muted)] flex flex-col gap-1">
            {m.sources.length > 0 && <span>Evidence from: {m.sources.join(', ')}</span>}
            {m.tags.length > 0 && <span>Tags: {m.tags.join(', ')}</span>}
            {m.source_url && <a href={m.source_url} target="_blank" rel="noopener noreferrer" className="text-[var(--brand)]">Original source ↗</a>}
          </div>
        )}
      </div>
    );
  }

  // ── Kind view ──────────────────────────────────────────────────────────────
  if (view.name === 'kind') {
    const group = index.groups.find(g => g.type === view.kind);
    const pages = group ? group.pages : [];
    const current = pages.filter(p => CURRENT.has(p.status) || !p.status);
    const history = pages.filter(p => !(CURRENT.has(p.status) || !p.status));
    const topics = [...new Set(current.map(p => p.topic).filter(Boolean))];
    const shown = topic ? current.filter(p => p.topic === topic) : current;
    const blurb: Record<string, string> = {
      goal: "What we're working toward, with where each stands today.",
      decision: 'Calls we made and rules we follow.',
      finding: "What we've learned about our money and our data. Each title is the claim.",
      context: 'Facts about our life that shape the numbers.',
      reflection: 'One look back per month.',
      source: 'Articles and videos worth keeping, summarised.',
    };
    return (
      <div className="animate-fade-in flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Back label="Wiki" onClick={back} />
          <h1 className="text-[24px] font-bold text-[var(--text)]">{WIKI_TYPE_LABELS[view.kind] || view.kind}</h1>
          <p className="text-[12px] leading-snug text-[var(--text-muted)]">{blurb[view.kind]}</p>
        </div>
        {topics.length > 1 && view.kind !== 'reflection' && (
          <div className="flex gap-2 overflow-x-auto pb-0.5">
            <button className={`shrink-0 h-9 px-3.5 rounded-full border text-[12px] leading-snug cursor-pointer ${!topic ? 'bg-[var(--brand)] border-[var(--brand)] text-white font-semibold' : 'bg-[var(--bg-card)] border-[var(--border)] text-[var(--text)]'}`} onClick={() => setTopic(null)}>
              {view.kind === 'finding' ? 'Standing' : 'Current'} {current.length}
            </button>
            {topics.map(t => (
              <button key={t} className={`shrink-0 h-9 px-3.5 rounded-full border text-[12px] leading-snug cursor-pointer ${topic === t ? 'bg-[var(--brand)] border-[var(--brand)] text-white font-semibold' : 'bg-[var(--bg-card)] border-[var(--border)] text-[var(--text)]'}`} onClick={() => setTopic(t)}>
                {titleCase(t.replace('-', ' '))}
              </button>
            ))}
          </div>
        )}
        {view.kind !== 'reflection' && current.length > 1 && <span className="text-[12px] leading-snug text-[var(--text-muted)] -mt-2">Most-linked first</span>}
        <div className="flex flex-col gap-2.5">
          {shown.map(p => (
            <button key={p.path} className={`${rowBtn} ${card} p-3 flex flex-col gap-1.5 text-[var(--text)]`} onClick={() => openPath(p.path)}>
              <span className="flex justify-between items-center gap-2 w-full">
                <StatusPill status={p.status} />
                {p.linkCount > 0 && <span className="text-[12px] leading-snug text-[var(--text-muted)]">linked from {p.linkCount}</span>}
              </span>
              <span className="font-semibold text-[15px]">{p.title}</span>
              {p.headline && <span className="t-body font-semibold tabular-nums">{p.headline}</span>}
              {p.lead && <span className="text-[12px] leading-snug text-[var(--text-muted)] line-clamp-3">{p.lead}</span>}
              <span className="text-[12px] leading-snug text-[var(--text-muted)]">{[p.topic && p.topic.replace('-', ' '), p.updated && `updated ${shortDate(p.updated)}`].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
          {shown.length === 0 && <p className="t-body text-[var(--text-muted)]">Nothing current here.</p>}
        </div>
        {history.length > 0 && (
          <details className={`${card} px-3`}>
            <summary className="min-h-[44px] flex items-center justify-between cursor-pointer font-semibold list-none">
              History <span className="font-normal text-[12px] leading-snug text-[var(--text-muted)]">{history.length} {view.kind === 'finding' ? 'refuted or superseded' : 'parked or closed'}</span>
            </summary>
            <div className="flex flex-col pb-2">
              {history.map(p => {
                const repl = p.superseded_by ? bySlug.get(p.superseded_by) : undefined;
                return (
                  <button key={p.path} className={`${rowBtn} flex flex-col gap-1 py-2.5 border-t border-[var(--border)] px-0`} onClick={() => openPath(p.path)}>
                    <span className="flex gap-2 items-center"><StatusPill status={p.status} />{p.updated && <span className="text-[12px] leading-snug text-[var(--text-muted)]">{shortDate(p.updated)}</span>}</span>
                    <span className={`t-body text-[var(--text-muted)] ${p.status === 'parked' ? '' : 'line-through'}`}>{p.title}</span>
                    {repl && <span className="text-[12px] leading-snug text-[var(--text-muted)]">Replaced by <span className="text-[var(--brand)]">{repl.title}</span></span>}
                  </button>
                );
              })}
            </div>
          </details>
        )}
      </div>
    );
  }

  // ── All pages ──────────────────────────────────────────────────────────────
  if (view.name === 'all') {
    const h = index.health;
    const problems = [h.brokenLinks && `${h.brokenLinks} broken link${h.brokenLinks > 1 ? 's' : ''}`, h.missingFields && `${h.missingFields} page${h.missingFields > 1 ? 's' : ''} missing header fields`].filter(Boolean);
    return (
      <div className="animate-fade-in flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Back label="Wiki" onClick={back} />
          <h1 className="text-[24px] font-bold text-[var(--text)]">All pages</h1>
          <p className="text-[12px] leading-snug text-[var(--text-muted)]">{index.totalPages} pages · {problems.length ? problems.join(' · ') : 'no broken links'}</p>
        </div>
        {index.groups.map(g => (
          <div key={g.type} className="flex flex-col">
            <h2 className="text-[12px] leading-snug font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">{g.label} · {g.pages.length}</h2>
            {g.pages.map(p => (
              <button key={p.path} className={`${rowBtn} min-h-[44px] flex items-center gap-2.5 border-b border-[var(--border)] px-0`} onClick={() => openPath(p.path)}>
                <span className={`flex-1 t-body ${CURRENT.has(p.status) || !p.status ? 'text-[var(--text)]' : 'text-[var(--text-muted)] line-through'}`}>{p.title}</span>
                {p.headline && <span className="text-[12px] leading-snug tabular-nums text-[var(--text-muted)] max-w-[40%] truncate">{p.headline}</span>}
                <span className="text-[11px] font-semibold shrink-0" style={{ color: WIKI_STATUS_COLORS[p.status] || 'var(--text-muted)' }}>{titleCase(p.status || '')}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    );
  }

  // ── Home ───────────────────────────────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const results = q ? all.filter(p => [p.title, p.short, p.lead, p.tags.join(' '), p.topic].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (CURRENT.has(b.status) ? 1 : 0) - (CURRENT.has(a.status) ? 1 : 0)) : [];
  const counts = Object.fromEntries(index.groups.map(g => [g.type, g.pages.length]));
  const home = index.home;

  return (
    <div className="animate-fade-in flex flex-col gap-[18px]">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-[24px] font-bold text-[var(--text)]">Wiki</h1>
          <button className="text-[12px] leading-snug text-[var(--brand)] bg-transparent border-none cursor-pointer p-0" onClick={() => go({ name: 'all' })}>All pages</button>
        </div>
        <label className="flex items-center gap-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-3 h-11">
          <Search className="w-4 h-4 text-[var(--text-muted)]" />
          <span className="sr-only">Search the wiki</span>
          <input type="search" placeholder="Search titles, answers, tags" value={search} onChange={e => setSearch(e.target.value)}
            className="flex-1 bg-transparent border-0 outline-none text-[var(--text)] t-body placeholder:text-[var(--text-muted)]" />
        </label>
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {KIND_ORDER.filter(k => counts[k]).map(k => (
            <button key={k} className="shrink-0 h-8 px-3 rounded-full bg-[var(--bg-card)] border border-[var(--border)] text-[12px] leading-snug text-[var(--text)] cursor-pointer" onClick={() => go({ name: 'kind', kind: k })}>
              {WIKI_TYPE_LABELS[k]} {counts[k]}
            </button>
          ))}
        </div>
      </div>

      {q ? (
        <section className="flex flex-col gap-2">
          <SectionHead title={`${results.length} result${results.length === 1 ? '' : 's'}`} />
          {results.map(p => (
            <button key={p.path} className={`${rowBtn} ${card} p-3 flex flex-col gap-1 text-[var(--text)]`} onClick={() => openPath(p.path)}>
              <span className="flex gap-2 items-center"><StatusPill status={p.status} /><span className="text-[12px] leading-snug text-[var(--text-muted)]">{(WIKI_TYPE_LABELS[p.type] || p.type).replace(/s$/, '')}</span></span>
              <span className="font-semibold">{p.title}</span>
              {p.lead && <span className="text-[12px] leading-snug text-[var(--text-muted)] line-clamp-2">{p.lead}</span>}
            </button>
          ))}
        </section>
      ) : (
        <>
          {home.goals.length > 0 && (
            <section>
              <SectionHead title="Goals" aside={home.goals.some(g => g.fromStatement) ? 'from your latest statement' : 'from your accounts'} />
              <div className="grid grid-cols-2 gap-2.5">
                {home.goals.map(g => {
                  const pct = g.progress ?? 0;
                  const ok = g.on_track !== false;
                  return (
                    <button key={g.path} className={`${rowBtn} ${card} p-3 flex flex-col gap-1.5 text-[var(--text)]`} onClick={() => openPath(g.path)}>
                      <span className="text-[12px] leading-snug text-[var(--text-muted)]">{g.short || g.title}</span>
                      <span className="text-[17px] font-bold leading-snug">{g.headline || '—'}</span>
                      <span className="h-1.5 rounded bg-[var(--border)] overflow-hidden block w-full">
                        <span className="block h-full" style={{ width: `${pct * 100}%`, background: ok ? 'var(--positive)' : 'var(--warning)' }} />
                      </span>
                      <span className="text-[12px] leading-snug font-semibold" style={{ color: ok ? 'var(--positive)' : 'var(--warning)' }}>{ok ? '✓ On track' : '! Behind plan'}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {home.rules.length > 0 && (
            <section>
              <SectionHead title="Rules we follow" aside={`${counts.decision || 0} decisions`} onAside={() => go({ name: 'kind', kind: 'decision' })} />
              <div className={`${card} flex flex-col`}>
                {home.rules.slice(0, 5).map((r, i) => (
                  <button key={r.path} className={`${rowBtn} flex gap-2.5 p-3 text-[var(--text)] ${i ? 'border-t border-[var(--border)]' : ''}`} onClick={() => openPath(r.path)}>
                    <Check className="w-[18px] h-[18px] shrink-0 mt-0.5 text-[var(--brand-light)]" />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold t-body">{r.title}</span>
                      {r.lead && <span className="text-[12px] leading-snug text-[var(--text-muted)] line-clamp-2">{r.lead}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {home.open.length > 0 && (
            <section>
              <SectionHead title="Open items" aside="from every page's Open section" />
              <div className={`${card} flex flex-col`}>
                {home.open.map((o, i) => (
                  <div key={i} className={`flex gap-2.5 p-3 ${i ? 'border-t border-[var(--border)]' : ''}`}>
                    <span className="shrink-0 w-4 h-4 rounded-[5px] border-[1.5px] border-[var(--text-muted)] mt-0.5" aria-hidden="true" />
                    <span className="flex flex-col gap-0.5">
                      <span className="t-body text-[var(--text)]">{o.text}</span>
                      <button className="text-[12px] leading-snug text-[var(--brand)] bg-transparent border-none p-0 text-left cursor-pointer" onClick={() => openPath(o.page)}>{o.pageTitle}</button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {home.recent.length > 0 && (
            <section>
              <SectionHead title="Recent changes" />
              <div className="flex flex-col gap-2.5">
                {home.recent.map((r, i) => (
                  <div key={i} className="grid grid-cols-[52px_minmax(0,1fr)] gap-2.5 text-[12px] leading-snug">
                    <span className="text-[var(--text-muted)]">{shortDate(r.date)}</span>
                    <span className="text-[var(--text)] line-clamp-2">{r.text}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <button className={`${rowBtn} ${card} min-h-[44px] px-3 flex items-center justify-between t-body text-[var(--text)]`} onClick={() => go({ name: 'kind', kind: 'finding' })}>
            Browse findings <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
          </button>
        </>
      )}
    </div>
  );
}

function WikiSkeleton() {
  return (
    <div className="animate-fade-in space-y-4">
      <div className="h-7 w-24 rounded bg-[var(--border)]" />
      <div className="h-11 w-full rounded-xl bg-[var(--border)]" />
      <div className="grid grid-cols-2 gap-2.5">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-28 rounded-[14px] bg-[var(--border)]" />)}
      </div>
      <div className="h-40 w-full rounded-[14px] bg-[var(--border)]" />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="animate-fade-in space-y-3">
      <div className="h-5 w-24 rounded-full bg-[var(--border)]" />
      <div className="h-7 w-64 rounded bg-[var(--border)]" />
      <div className="h-24 w-full rounded-[14px] bg-[var(--border)]" />
      <div className="h-3 w-full rounded bg-[var(--border)]" />
      <div className="h-3 w-5/6 rounded bg-[var(--border)]" />
    </div>
  );
}
