// Under every chat box: small and quiet, not a banner.
export function AiDisclaimer({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[11px] leading-snug text-brain-text-muted text-center ${className}`}>
      NodeBrain uses AI that can make mistakes. Check what your agents do.
    </p>
  );
}
