import { useEffect, useState, useCallback } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtAge } from '@/lib/format';
import { WIKI_TYPE_LABELS, WIKI_STATUS_COLORS } from '@/lib/constants';
import { MarkdownRenderer } from '@/components/shared/MarkdownRenderer';
import { showBackButton, hideBackButton } from '@/lib/telegram';
import {
  ChevronLeft, ChevronRight, Search,
  Target, Heart, AlertTriangle, Info, TrendingUp, ExternalLink, BookOpen,
} from 'lucide-react';
import type { WikiIndexData, WikiPageData, WikiPageMeta } from '@/lib/types';

const TYPE_ICONS: Record<string, typeof Target> = {
  goal: Target,
  preference: Heart,
  concern: AlertTriangle,
  context: Info,
  pattern: TrendingUp,
  article: ExternalLink,
  reflection: BookOpen,
};

const SOURCE_BADGES: Record<string, string> = {
  tweet: 'Tweet',
  article: 'Article',
  video: 'Video',
  pdf: 'PDF',
};

export function Wiki() {
  const [index, setIndex] = useState<WikiIndexData | null>(null);
  const [page, setPage] = useState<WikiPageData | null>(null);
  const [pageMeta, setPageMeta] = useState<WikiPageMeta | null>(null);
  const [pagePath, setPagePath] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Fetch index on mount
  useEffect(() => {
    fetchWithAuth<WikiIndexData>('/api/wiki')
      .then(setIndex)
      .catch(e => setError(e.message));
  }, []);

  // Fetch page when pagePath changes
  useEffect(() => {
    if (!pagePath) {
      setPage(null);
      return;
    }
    setPage(null);
    fetchWithAuth<WikiPageData>('/api/wiki/page', { path: pagePath })
      .then(setPage)
      .catch(e => {
        setError(e.message);
        setPagePath(null);
      });
  }, [pagePath]);

  // Navigate to page
  const openPage = useCallback((meta: WikiPageMeta) => {
    setPageMeta(meta);
    setPagePath(meta.path);
  }, []);

  const goBack = useCallback(() => {
    setPagePath(null);
    setPageMeta(null);
  }, []);

  // Telegram BackButton integration
  useEffect(() => {
    if (!pagePath) return;
    showBackButton(goBack);
    return () => hideBackButton(goBack);
  }, [pagePath, goBack]);

  // Handle internal wiki link navigation
  const handleNavigate = useCallback((path: string) => {
    // Find meta from index if available
    if (index) {
      for (const group of index.groups) {
        const found = group.pages.find(p => p.path === path);
        if (found) {
          openPage(found);
          return;
        }
      }
    }
    // Navigate even without meta
    setPageMeta(null);
    setPagePath(path);
  }, [index, openPage]);

  // Toggle section collapse
  const toggleSection = useCallback((type: string) => {
    setCollapsed(prev => ({ ...prev, [type]: !prev[type] }));
  }, []);

  // Error state
  if (error && !index) {
    return (
      <div className="py-12 text-center">
        <p className="t-body text-[var(--text-muted)]">{error}</p>
      </div>
    );
  }

  // Loading state
  if (!index) {
    return <WikiSkeleton />;
  }

  // Page view
  if (pagePath) {
    return (
      <div className="animate-fade-in">
        {/* Back button */}
        <button
          className="flex items-center gap-1 mb-4 text-[var(--brand)] bg-transparent border-none cursor-pointer p-0 t-caption"
          onClick={goBack}
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        {!page ? (
          <PageSkeleton />
        ) : (
          <div className="md:max-w-[680px]">
            {/* Title */}
            <h1 className="t-value text-[var(--text)] text-lg md:text-xl mb-2">{page.title}</h1>

            {/* Metadata bar */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {pageMeta && (
                <>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--brand)]/10 text-[var(--brand)]">
                    {WIKI_TYPE_LABELS[pageMeta.type] || pageMeta.type}
                  </span>
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: WIKI_STATUS_COLORS[pageMeta.status] || 'var(--text-muted)' }}
                    title={pageMeta.status}
                  />
                  {pageMeta.updated && (
                    <span className="t-micro text-[var(--text-muted)]">
                      Updated {fmtAge(pageMeta.updated + 'T00:00:00')}
                    </span>
                  )}
                  {pageMeta.tags.length > 0 && pageMeta.tags.map(tag => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--border)]/50 text-[var(--text-muted)]"
                    >
                      {tag}
                    </span>
                  ))}
                  {pageMeta.source_url && (
                    <a
                      href={pageMeta.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--brand)] t-micro underline decoration-[var(--brand)]/30"
                    >
                      Source ↗
                    </a>
                  )}
                </>
              )}
            </div>

            {/* Body */}
            <MarkdownRenderer content={page.body} onNavigate={handleNavigate} />
          </div>
        )}
      </div>
    );
  }

  // Index view
  const lowerSearch = search.toLowerCase();
  const filteredGroups = index.groups
    .map(group => ({
      ...group,
      pages: search
        ? group.pages.filter(p =>
            p.title.toLowerCase().includes(lowerSearch) ||
            p.tags.some(t => t.toLowerCase().includes(lowerSearch))
          )
        : group.pages,
    }))
    .filter(g => g.pages.length > 0);

  // Empty state
  if (index.totalPages === 0) {
    return (
      <div className="animate-fade-in py-16 text-center px-6">
        <p className="t-value text-[var(--text)] mb-2">No wiki pages yet</p>
        <p className="t-body text-[var(--text-muted)] leading-relaxed">
          Your knowledge base will appear here as the agent captures goals, preferences, and insights.
        </p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
        <input
          type="text"
          placeholder="Search pages..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text)] t-body placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--brand)]"
        />
      </div>

      {/* Page count */}
      <p className="t-micro text-[var(--text-muted)] mb-3">
        {index.totalPages} page{index.totalPages !== 1 ? 's' : ''}
      </p>

      {/* Groups */}
      <div className="space-y-3">
        {filteredGroups.map(group => {
          const Icon = TYPE_ICONS[group.type] || BookOpen;
          const isCollapsed = collapsed[group.type] ?? false;

          return (
            <div key={group.type}>
              {/* Group header */}
              <button
                className="flex items-center gap-2 w-full bg-transparent border-none cursor-pointer p-0 mb-2"
                onClick={() => toggleSection(group.type)}
              >
                <Icon className="w-4 h-4 text-[var(--brand)]" />
                <span className="t-caption text-[var(--text)] font-medium">{group.label}</span>
                <span className="t-micro text-[var(--text-muted)]">{group.pages.length}</span>
                <ChevronRight
                  className={`w-3.5 h-3.5 text-[var(--text-muted)] ml-auto transition-transform duration-150 ${
                    isCollapsed ? '' : 'rotate-90'
                  }`}
                />
              </button>

              {/* Pages */}
              {!isCollapsed && (
                <div className="space-y-1 md:space-y-0 md:grid md:grid-cols-2 md:gap-2 ml-6">
                  {group.pages.map(page => (
                    <button
                      key={page.path}
                      className="w-full text-left bg-transparent border-none cursor-pointer p-2 md:p-3 rounded-lg hover:bg-[var(--bg-card)] md:border md:border-transparent md:hover:border-[var(--border)] transition-colors duration-100"
                      onClick={() => openPage(page)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="t-body text-[var(--text)] truncate flex-1">{page.title}</span>
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: WIKI_STATUS_COLORS[page.status] || 'var(--text-muted)' }}
                          title={page.status}
                        />
                        {page.source_type && SOURCE_BADGES[page.source_type] && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] bg-[var(--border)]/50 text-[var(--text-muted)] shrink-0">
                            {SOURCE_BADGES[page.source_type]}
                          </span>
                        )}
                      </div>
                      {page.summary && (
                        <p className="t-micro text-[var(--text-muted)] mt-0.5 line-clamp-1 md:line-clamp-2">{page.summary}</p>
                      )}
                      {page.updated && (
                        <p className="t-micro text-[var(--text-muted)] mt-0.5 opacity-50">
                          {fmtAge(page.updated + 'T00:00:00')}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* No search results */}
      {search && filteredGroups.length === 0 && (
        <div className="py-8 text-center">
          <p className="t-body text-[var(--text-muted)]">No pages match "{search}"</p>
        </div>
      )}
    </div>
  );
}

function WikiSkeleton() {
  return (
    <div className="animate-fade-in space-y-4">
      <div className="h-9 w-full rounded-lg bg-[var(--border)]" />
      <div className="h-3 w-16 rounded bg-[var(--border)]" />
      {[1, 2, 3].map(i => (
        <div key={i}>
          <div className="h-4 w-24 rounded bg-[var(--border)] mb-2" />
          <div className="space-y-2 ml-6">
            <div className="h-8 w-full rounded bg-[var(--border)]" />
            <div className="h-8 w-full rounded bg-[var(--border)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="animate-fade-in space-y-3">
      <div className="h-6 w-48 rounded bg-[var(--border)]" />
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded-full bg-[var(--border)]" />
        <div className="h-5 w-24 rounded bg-[var(--border)]" />
      </div>
      <div className="h-3 w-full rounded bg-[var(--border)]" />
      <div className="h-3 w-full rounded bg-[var(--border)]" />
      <div className="h-3 w-3/4 rounded bg-[var(--border)]" />
      <div className="h-3 w-full rounded bg-[var(--border)] mt-4" />
      <div className="h-3 w-5/6 rounded bg-[var(--border)]" />
    </div>
  );
}
