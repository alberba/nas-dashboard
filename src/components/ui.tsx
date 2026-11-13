import type { ReactNode } from "react";

export type Tone = "gain" | "loss" | "peach" | "lilac" | "accent" | "muted";

export function StatusDot({ tone }: { tone: Tone }) {
  return <i className={`dot ${tone}`} aria-hidden="true" />;
}

export type StripSegment = {
  id: string;
  label: string;
  value: ReactNode;
  tone?: Tone;
  detail?: ReactNode;
};

export function StatusStrip({
  label,
  segments,
}: {
  label: string;
  segments: StripSegment[];
}) {
  return (
    <div className="status-strip" role="group" aria-label={label}>
      {segments.map((segment) => (
        <div
          className="strip-segment"
          key={segment.id}
          data-segment={segment.id}
        >
          <span className="strip-label">{segment.label}</span>
          <span className="strip-value">
            {segment.tone && <StatusDot tone={segment.tone} />}
            {segment.value}
          </span>
          {segment.detail && (
            <span className="strip-detail">{segment.detail}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function Panel({
  id,
  title,
  count,
  tools,
  children,
  className = "",
}: {
  id: string;
  title: string;
  count?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`data-panel ${className}`} aria-labelledby={id}>
      <header className="panel-head">
        <h2 id={id}>
          {title}
          {count !== undefined && <span className="panel-count">{count}</span>}
        </h2>
        {tools}
      </header>
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { id: T; label: ReactNode }[];
  value: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          onClick={() => onSelect(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function FilterChips<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { id: T; label: string; count: number }[];
  value: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="filter-chip"
          aria-pressed={option.id === value}
          data-filter={option.id}
          data-count={option.count}
          onClick={() => onSelect(option.id)}
        >
          {option.label}
          <span className="filter-count">{option.count}</span>
        </button>
      ))}
    </div>
  );
}
