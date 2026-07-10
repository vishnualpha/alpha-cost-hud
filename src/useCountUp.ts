import { useEffect, useRef, useState } from "react";

// Smoothly eases a displayed number toward `target`. Used for the hero money +
// tokens so they "tick up" when data refreshes instead of snapping — the live,
// stock-ticker feel. Eases quickly (500ms) so it never feels laggy.
export function useCountUp(target: number, duration = 500): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(0);
  const rafRef = useRef<number>();

  useEffect(() => {
    fromRef.current = value;
    startRef.current = performance.now();
    const from = fromRef.current;
    const delta = target - from;
    if (Math.abs(delta) < 1e-9) {
      setValue(target);
      return;
    }

    const tick = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(from + delta * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, duration]);

  return value;
}
