import type { ReactNode } from "react";

export function ViewHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="view-header">
      <span className="view-title">{title}</span>
      <span className="grow" />
      {children}
    </div>
  );
}
