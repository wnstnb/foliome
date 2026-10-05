import { useEffect, useState, useCallback } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtShort } from '@/lib/format';
import { getTg, haptic, showBackButton, hideBackButton } from '@/lib/telegram';
import { ChevronLeft, ChevronRight, ChevronDown, Download, Send, FileText } from 'lucide-react';
import { EmptyState } from '@/components/shared/EmptyState';
import type { StatementsData, PeriodicStatement, FinancialStatement } from '@/lib/types';

// Two doors: periodic statements (monthly + custom) and financial statements (quarterly PFS + scenarios).
// A statement opens exactly as issued: the frozen statement page, served through a short-lived signed link.
type View =
  | { name: 'home' }
  | { name: 'periodic' }
  | { name: 'financial' }
  | { name: 'viewer'; id: string; title: string; sub: string; revisions: { rev: number; id: string }[]; from: 'periodic' | 'financial' };

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d?: string | null) => { if (!d) return ''; const [y, m, dd] = d.slice(0, 10).split('-'); return `${MON[+m - 1]} ${+dd}, ${y}`; };
const whole = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const signed = (n: number) => `${n >= 0 ? '▲ +' : '▼ −'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
// Next run of a monthly (or listed-months) schedule, or null when the user hasn't scheduled one
type Sched = { day: number; months: number[] | null } | null;
const nextRun = (s: Sched) => {
  if (!s) return null;
  const now = new Date();
  for (let k = 0; k < 24; k++) {
    const n = new Date(now.getFullYear(), now.getMonth() + k, s.day, 23, 59);
    if (n > now && (!s.months || s.months.includes(n.getMonth() + 1))) return `${MON[n.getMonth()]} ${n.getDate()}`;
  }
  return null;
};
const ordinal = (n: number) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };

function Micro({ children }: { children: React.ReactNode }) {
  return <span className="t-micro text-[var(--text-muted)]">{children}</span>;
}

function Back({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="flex items-center gap-1 min-h-[44px] text-[var(--brand)] bg-transparent border-none cursor-pointer p-0 t-body" onClick={onClick}>
      <ChevronLeft className="w-4 h-4" />{label}
    </button>
  );
}

function Shelf({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!count) return null;
  return (
    <div className="border border-dashed border-[var(--border)] rounded-xl">
      <button className="w-full flex justify-between items-center px-4 min-h-[48px] bg-transparent border-none cursor-pointer text-[var(--text)] t-body" onClick={() => setOpen(o => !o)}>
        <span>{title} <span className="text-[var(--text-muted)]">· {count}</span></span>
        <ChevronDown className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="flex flex-col gap-2 px-3 pb-3">{children}</div>}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [i * (320 / (values.length - 1)), 60 - ((v - lo) / span) * 48]);
  const last = pts[pts.length - 1];
  return (
    <svg viewBox="0 0 320 70" width="100%" height="70" aria-hidden="true">
      <path d={'M' + pts.map(p => p.join(',')).join(' L')} fill="none" stroke="var(--brand)" strokeWidth="2.5" />
      <circle cx={last[0]} cy={last[1]} r="4" fill="var(--brand)" />
      <line x1="0" x2="320" y1="69" y2="69" stroke="var(--border)" />
    </svg>
  );
}

function PeriodicCard({ s, onOpen, latest }: { s: PeriodicStatement; onOpen: () => void; latest?: boolean }) {
  return (
    <button onClick={onOpen} className={`w-full text-left rounded-xl p-3.5 bg-[var(--bg-card)] border cursor-pointer text-[var(--text)] ${latest ? 'border-[var(--brand)]' : 'border-[var(--border)]'}`}>
      <div className="flex justify-between items-baseline gap-2">
        <span className="font-bold">{s.label}</span>
        <span className="t-caption text-[var(--text-muted)]">{s.kind === 'issued' ? `issued ${shortDate(s.issuedAt)}` : 'custom period'}{s.rev > 1 ? ` · rev ${s.rev}` : ''}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-2">
        <div className="flex flex-col"><Micro>Net worth</Micro><span className={`font-semibold tabular-nums ${s.netWorthChange >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>{signed(s.netWorthChange)}</span></div>
        <div className="flex flex-col"><Micro>Left over</Micro><span className="font-semibold tabular-nums">{whole(s.left)} {s.typicalLeft != null && <span className="font-normal t-caption text-[var(--text-muted)]">typ. {whole(s.typicalLeft)}</span>}</span></div>
      </div>
      <div className={`t-caption mt-2 ${s.flags ? 'text-[var(--warning)]' : 'text-[var(--positive)]'}`}>{s.flags ? `! ${s.flags} to look at` : '✓ nothing flagged'}</div>
    </button>
  );
}

function FinancialCard({ s, onOpen, latest }: { s: FinancialStatement; onOpen: () => void; latest?: boolean }) {
  return (
    <button onClick={onOpen} className={`w-full text-left rounded-xl p-3.5 bg-[var(--bg-card)] border cursor-pointer text-[var(--text)] ${latest ? 'border-[var(--brand)]' : 'border-[var(--border)]'}`}>
      <div className="flex justify-between items-baseline gap-2">
        <span className="font-bold">{s.scenario ? s.label : `Financial statement`}</span>
        <span className="t-caption text-[var(--text-muted)]">{shortDate(s.asOf)}{s.rev > 1 ? ` · rev ${s.rev}` : ''}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-2">
        <div className="flex flex-col"><Micro>Net worth</Micro><span className="font-semibold">{s.netWorth != null ? fmtShort(s.netWorth) : '—'}</span></div>
        <div className="flex flex-col"><Micro>Surplus</Micro><span className="font-semibold">{s.surplus != null ? fmtShort(s.surplus) : '—'}</span></div>
        <div className="flex flex-col"><Micro>On track</Micro><span className={`font-semibold ${s.goals && s.goalsOnPace < s.goals ? 'text-[var(--warning)]' : ''}`}>{s.goalsOnPace} of {s.goals}</span></div>
      </div>
      {s.topDecision && <div className="t-caption text-[var(--text-muted)] mt-2">Top decision: {s.topDecision}</div>}
    </button>
  );
}

function Viewer({ view, onBack }: { view: Extract<View, { name: 'viewer' }>; onBack: () => void }) {
  const [id, setId] = useState(view.id);
  const [src, setSrc] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSrc(null);
    fetchWithAuth<{ url: string }>('/api/statements/link', { id, file: 'html' })
      .then(r => setSrc(new URL(r.url, document.baseURI).href))
      .catch(() => setNote('This statement could not be opened.'));
  }, [id]);

  const download = useCallback(async () => {
    setBusy(true); setNote(null); haptic('light');
    let step = 'getting a download link';
    try {
      const r = await fetchWithAuth<{ url: string; name: string }>('/api/statements/link', { id, file: 'pdf' });
      const url = new URL(r.url, document.baseURI).href;
      const tg = getTg();
      if (tg?.initData) {
        // Telegram 8.0+ has a native save sheet; older clients (or a refused call) open the link in the browser
        let native = false;
        if (tg.downloadFile && tg.isVersionAtLeast?.('8.0')) {
          step = `Telegram's download (app version ${tg.version})`;
          try { tg.downloadFile({ url, file_name: r.name }, ok => { if (!ok) setNote('Download cancelled.'); }); native = true; }
          catch (e) { console.warn('downloadFile failed', e); }
        }
        if (!native) { step = `opening the browser (app version ${tg.version})`; if (tg.openLink) tg.openLink(url); else window.open(url, '_blank'); setNote('Opening the PDF in your browser.'); }
      } else {
        step = 'starting the download';
        const a = document.createElement('a'); a.href = url; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
      }
    } catch (e) { setNote(`The PDF could not be downloaded (${step}: ${e instanceof Error ? e.message : String(e)}).`); }
    setBusy(false);
  }, [id]);

  const send = useCallback(async () => {
    setBusy(true); setNote(null); haptic('light');
    try {
      const r = await fetchWithAuth<{ sent: boolean }>('/api/statements/send', { id });
      setNote(r.sent ? 'Sent. It\'s in your chat with the bot.' : 'Sending failed; try Download instead.');
    } catch { setNote('Sending failed; try Download instead.'); }
    setBusy(false);
  }, [id]);

  return (
    <div className="flex flex-col gap-3">
      <Back label={view.from === 'periodic' ? 'Periodic statements' : 'Financial statements'} onClick={onBack} />
      <div className="flex flex-col gap-0.5">
        <span className="text-xl font-bold">{view.title}</span>
        <span className="t-caption text-[var(--text-muted)]">{view.sub} · as issued, never changes</span>
      </div>
      <div className="flex gap-2 flex-wrap">
        <button disabled={busy} onClick={download} className="flex-1 min-h-[44px] rounded-lg bg-[var(--brand)] text-white border-none font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60">
          <Download className="w-4 h-4" />Download PDF
        </button>
        <button disabled={busy} onClick={send} className="min-h-[44px] px-3 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text)] text-sm flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60">
          <Send className="w-4 h-4" />Send to chat
        </button>
        {view.revisions.length > 1 && (
          <select value={id} onChange={e => setId(e.target.value)} aria-label="Revision" className="min-h-[44px] px-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text)] text-sm">
            {view.revisions.map(r => <option key={r.id} value={r.id}>Revision {r.rev}</option>)}
          </select>
        )}
      </div>
      {note && <div className="t-caption text-[var(--text-muted)]">{note}</div>}
      <div className="rounded-lg overflow-hidden border border-[var(--border)] bg-white" style={{ height: 'calc(100vh - 230px)', minHeight: 420 }}>
        {src ? <iframe title={view.title} src={src} sandbox="" className="w-full h-full border-0" /> : <div className="p-6 t-caption text-gray-500">Opening…</div>}
      </div>
    </div>
  );
}

export function Statements() {
  const [data, setData] = useState<StatementsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ name: 'home' });

  useEffect(() => {
    fetchWithAuth<StatementsData>('/api/statements').then(setData).catch(e => setError(e.message));
  }, []);

  const back = useCallback(() => setView(v => (v.name === 'viewer' ? { name: v.from } : { name: 'home' })), []);
  useEffect(() => {
    if (view.name === 'home') return;
    showBackButton(back);
    return () => hideBackButton(back);
  }, [view, back]);

  if (error) return <EmptyState message={`Could not load statements (${error}).`} />;
  if (!data) return <EmptyState message="Loading statements…" />;

  const issued = data.periodic.issued, custom = data.periodic.custom;
  const fin = data.financial.statements, scen = data.financial.scenarios;
  const nextP = nextRun(data.schedule?.periodic ?? null), nextF = nextRun(data.schedule?.financial ?? null);
  const openPeriodic = (s: PeriodicStatement) => setView({ name: 'viewer', id: s.id, title: s.label, sub: s.kind === 'issued' ? `Statement of activity · issued ${shortDate(s.issuedAt)}` : 'Statement of activity · custom period', revisions: s.revisions, from: 'periodic' });
  const openFinancial = (s: FinancialStatement) => setView({ name: 'viewer', id: s.id, title: s.scenario ? s.label : 'Financial statement', sub: `As of ${shortDate(s.asOf)}`, revisions: s.revisions, from: 'financial' });

  if (view.name === 'viewer') return <Viewer key={view.id} view={view} onBack={back} />;

  if (view.name === 'periodic') return (
    <div className="flex flex-col gap-3">
      <Back label="Statements" onClick={back} />
      <div className="flex flex-col"><span className="text-xl font-bold">Periodic statements</span><span className="t-caption text-[var(--text-muted)]">{data.schedule?.periodic ? `Issued on the ${ordinal(data.schedule.periodic.day)} of each month` : 'Issued when you ask'} · frozen once issued</span></div>
      {issued.length ? issued.map((s, i) => <PeriodicCard key={s.id} s={s} latest={i === 0} onOpen={() => openPeriodic(s)} />) : <EmptyState message={nextP ? `No statements issued yet. The first one arrives ${nextP}.` : 'No statements issued yet. Ask for one ("issue last month"), or schedule them monthly.'} />}
      <Shelf title="Custom periods" count={custom.length}>{custom.map(s => <PeriodicCard key={s.id} s={s} onOpen={() => openPeriodic(s)} />)}</Shelf>
    </div>
  );

  if (view.name === 'financial') return (
    <div className="flex flex-col gap-3">
      <Back label="Statements" onClick={back} />
      <div className="flex flex-col"><span className="text-xl font-bold">Financial statements</span><span className="t-caption text-[var(--text-muted)]">{nextF ? `Next review ${nextF}` : 'Reviewed when you ask'}</span></div>
      {fin.length ? fin.map((s, i) => <FinancialCard key={s.id} s={s} latest={i === 0} onOpen={() => openFinancial(s)} />) : <EmptyState message="No financial statement yet. Ask for one to get started." />}
      <Shelf title="Scenarios" count={scen.length}>{scen.map(s => <FinancialCard key={s.id} s={s} onOpen={() => openFinancial(s)} />)}</Shelf>
    </div>
  );

  const door = (title: string, sub: string, latest: React.ReactNode, next: string, count: string, onClick: () => void) => (
    <button onClick={onClick} className="w-full text-left rounded-2xl p-4 bg-[var(--bg-card)] border border-[var(--border)] cursor-pointer text-[var(--text)]">
      <div className="flex justify-between items-baseline gap-2"><span className="text-[17px] font-bold">{title}</span><ChevronRight className="w-5 h-5 text-[var(--brand)]" /></div>
      <div className="t-caption text-[var(--text-muted)] mt-0.5">{sub}</div>
      <div className="flex justify-between gap-2 mt-3.5 pt-3 border-t border-[var(--border)]">
        <div className="flex flex-col gap-0.5"><Micro>Latest</Micro>{latest}</div>
        <div className="flex flex-col gap-0.5 items-end"><Micro>Next</Micro><span className="font-semibold">{next}</span><span className="t-caption text-[var(--text-muted)]">{count}</span></div>
      </div>
    </button>
  );
  const lp = issued[0], lf = fin[0];
  return (
    <div className="flex flex-col gap-3">
      {door('Periodic statements', 'Monthly activity, like a bank statement for the whole household',
        lp ? <><span className="font-semibold">{lp.label}</span><span className="t-caption text-[var(--text-muted)]">issued {shortDate(lp.issuedAt)} · {signed(lp.netWorthChange)}</span></> : <span className="t-caption text-[var(--text-muted)]">none issued yet</span>,
        nextP ?? 'On request', `${issued.length} issued${custom.length ? ` · ${custom.length} custom` : ''}`, () => setView({ name: 'periodic' }))}
      {door('Financial statements', 'Quarterly personal financial statement: where you\'re going and what to do',
        lf ? <><span className="font-semibold">{shortDate(lf.asOf)}</span><span className="t-caption text-[var(--text-muted)]">{lf.surplus != null ? `surplus ${fmtShort(lf.surplus)}` : ''}</span></> : <span className="t-caption text-[var(--text-muted)]">none yet</span>,
        nextF ?? 'On request', `${fin.length} statement${fin.length === 1 ? '' : 's'}${scen.length ? ` · ${scen.length} scenario${scen.length === 1 ? '' : 's'}` : ''}`, () => setView({ name: 'financial' }))}
      {data.across.length >= 2 && (
        <div className="rounded-2xl p-4 bg-[var(--bg-card)] border border-[var(--border)] flex flex-col gap-2">
          <div className="flex justify-between items-baseline"><Micro>Across statements</Micro><span className="t-caption text-[var(--text-muted)]">from issued statements only</span></div>
          <div className="flex justify-between items-baseline"><span className="t-caption text-[var(--text-muted)]">Net worth at month end</span><span className="font-semibold tabular-nums">{whole(data.across[data.across.length - 1].netWorth)}</span></div>
          <Spark values={data.across.map(a => a.netWorth)} />
          <div className="flex justify-between t-caption text-[var(--text-muted)]">{data.across.map(a => <span key={a.period}>{MON[+a.period.slice(5, 7) - 1]}</span>)}</div>
        </div>
      )}
      {!issued.length && !fin.length && (
        <div className="flex items-center gap-2 t-caption text-[var(--text-muted)]"><FileText className="w-4 h-4" />Statements appear here once they're issued.</div>
      )}
    </div>
  );
}
