import type { ReactNode } from "react";

/** A blank view that says what will appear there, and how to make it appear. */
export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty-state-title">{title}</p>
      {children && <p className="empty-state-body">{children}</p>}
    </div>
  );
}
