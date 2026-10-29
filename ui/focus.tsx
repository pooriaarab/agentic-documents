import { useEffect, useRef, type ReactNode } from "react";

// A new view puts focus on its heading, so a keyboard or screen reader user lands on it.
// The first load does not, so the skip link stays the first tab stop.
let pending = false;
export const routeChanged = (): void => void (pending = true);

export function PageHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!pending) return;
    pending = false;
    ref.current?.focus({ preventScroll: true });
  }, []);
  return <h1 ref={ref} tabIndex={-1}>{children}</h1>;
}
