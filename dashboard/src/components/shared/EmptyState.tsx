interface EmptyStateProps {
  message: string;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="py-12 text-center">
      <p className="t-body text-[var(--text-muted)]">{message}</p>
    </div>
  );
}
