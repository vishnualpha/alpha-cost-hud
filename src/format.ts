// Money + count formatting for the compact HUD.

export function money(n: number): string {
  if (!isFinite(n)) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function agentsLabel(active: number, total: number): string {
  if (total === 0) return "no agents";
  return `${active}/${total} agent${total === 1 ? "" : "s"}`;
}

export function tokens(n: number): string {
  if (!isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

// Full-precision money for the big hero number (splits dollars/cents for styling).
export function moneyParts(n: number): { dollars: string; cents: string } {
  const v = isFinite(n) ? n : 0;
  const dollars = Math.floor(v).toLocaleString("en-US");
  const cents = Math.round((v - Math.floor(v)) * 100)
    .toString()
    .padStart(2, "0");
  return { dollars, cents };
}

export function relativeTime(ts: number | null): string {
  if (!ts) return "—";
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}
