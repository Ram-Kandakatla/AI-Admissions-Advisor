// A small compass rose — the app's mark. Colors come from the theme tokens
// so the mark inverts correctly in dark mode.
export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" stroke="var(--tx)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="2" fill="var(--tx)" />
      {/* North needle — accent */}
      <path d="M16 4.5 L19 15 L16 16 L13 15 Z" fill="var(--blue)" />
      {/* South needle — muted */}
      <path d="M16 27.5 L13 17 L16 16 L19 17 Z" fill="var(--txf)" />
    </svg>
  );
}
