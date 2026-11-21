// The page entrance (spec 06 §5.1, shell-v2 §7.3): `.fin-enter` on the frame's content wrapper,
// remounted only when the key changes. The frames key it by pathname, so `?tab=`, `?view=` and
// filters never replay it. The motion itself is fin-motion.css's (reduced motion keeps only the
// fade, capped at 140ms).
import type { ReactNode } from "react";

export interface EnterProps {
  /** Remounts (and so replays) the entrance when it changes: the pathname. */
  keyBy: string;
  className?: string;
  children: ReactNode;
}

export function Enter({ keyBy, className, children }: EnterProps) {
  return (
    <div key={keyBy} className={className === undefined ? "fin-enter" : `fin-enter ${className}`}>
      {children}
    </div>
  );
}
