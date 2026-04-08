import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { Components } from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
  onNavigate?: (path: string) => void;
}

/**
 * Secure markdown renderer for wiki pages.
 *
 * Security:
 * - No rehype-raw (raw HTML rendered as text, not DOM)
 * - javascript:/data: URLs blocked
 * - External images blocked (all src rewritten to /api/wiki/asset)
 * - Internal wiki links intercepted via onNavigate callback
 * - External links open in new tab with rel="noopener noreferrer"
 */
export function MarkdownRenderer({ content, onNavigate }: MarkdownRendererProps) {
  const components: Components = {
    a({ href, children }) {
      if (!href) return <span>{children}</span>;

      // Block dangerous protocols
      const lower = href.toLowerCase().trim();
      if (lower.startsWith('javascript:') || lower.startsWith('data:')) {
        return <span className="text-[var(--text-muted)]">{children}</span>;
      }

      // Internal wiki links (relative .md links)
      if (href.endsWith('.md') && !href.startsWith('http')) {
        const wikiPath = href
          .replace(/^\.\.\//, '')
          .replace(/^\.\//, '')
          .replace(/\.md$/, '');
        return (
          <button
            className="text-[var(--brand)] underline decoration-[var(--brand)]/30 hover:decoration-[var(--brand)] bg-transparent border-none cursor-pointer p-0 font-inherit text-inherit"
            onClick={() => onNavigate?.(wikiPath)}
          >
            {children}
          </button>
        );
      }

      // External links
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--brand)] underline decoration-[var(--brand)]/30 hover:decoration-[var(--brand)]"
        >
          {children}
          <span className="inline-block ml-0.5 text-[10px] opacity-50">↗</span>
        </a>
      );
    },

    img({ src, alt }) {
      if (!src) return null;
      // Rewrite all image sources to go through the asset API (path-confined)
      const assetPath = src
        .replace(/^\.\.\//, '')
        .replace(/^\.\//, '');
      return (
        <img
          src={`/api/wiki/asset?path=${encodeURIComponent(assetPath)}`}
          alt={alt || ''}
          className="max-w-full rounded-lg my-2"
          loading="lazy"
        />
      );
    },

    h1({ children }) {
      return <h1 className="t-value text-[var(--text)] text-lg mb-3 mt-4 first:mt-0">{children}</h1>;
    },
    h2({ children }) {
      return <h2 className="t-value text-[var(--text)] text-base mb-2 mt-4">{children}</h2>;
    },
    h3({ children }) {
      return <h3 className="t-value text-[var(--text)] text-sm mb-2 mt-3">{children}</h3>;
    },

    p({ children }) {
      return <p className="t-body text-[var(--text)] leading-relaxed mb-2">{children}</p>;
    },

    ul({ children }) {
      return <ul className="t-body text-[var(--text)] pl-5 mb-2 list-disc space-y-1">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="t-body text-[var(--text)] pl-5 mb-2 list-decimal space-y-1">{children}</ol>;
    },
    li({ children }) {
      return <li className="leading-relaxed">{children}</li>;
    },

    blockquote({ children }) {
      return (
        <blockquote className="border-l-2 border-[var(--brand)] pl-3 my-2 text-[var(--text-muted)] italic">
          {children}
        </blockquote>
      );
    },

    code({ className, children }) {
      const isBlock = className?.startsWith('language-');
      if (isBlock) {
        return (
          <pre className="bg-[var(--bg-card)] rounded-lg p-3 my-2 overflow-x-auto">
            <code className="t-caption text-[var(--text)] font-mono text-xs">{children}</code>
          </pre>
        );
      }
      return (
        <code className="bg-[var(--bg-card)] rounded px-1.5 py-0.5 t-caption text-[var(--text)] font-mono text-xs">
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },

    table({ children }) {
      return (
        <div className="overflow-x-auto my-2">
          <table className="w-full text-left border-collapse">{children}</table>
        </div>
      );
    },
    th({ children }) {
      return (
        <th className="t-caption text-[var(--text-muted)] font-medium border-b border-[var(--border)] px-2 py-1.5 text-xs">
          {children}
        </th>
      );
    },
    td({ children }) {
      return (
        <td className="t-body text-[var(--text)] border-b border-[var(--border)] px-2 py-1.5 text-xs">
          {children}
        </td>
      );
    },

    hr() {
      return <hr className="border-[var(--border)] my-4" />;
    },

    strong({ children }) {
      return <strong className="font-semibold text-[var(--text)]">{children}</strong>;
    },
  };

  return (
    <div className="wiki-content">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
