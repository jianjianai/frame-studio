import type { ReactNode } from "react";
import { Menu } from "lucide-react";

/** Title row of a home page view; on narrow screens it also opens the navigation. */
export function PageHead({
  icon,
  title,
  meta,
  actions,
  onNav,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onNav: () => void;
}) {
  return (
    <header className="home-head">
      <button className="icon-btn home-nav-btn" aria-label="导航" onClick={onNav}>
        <Menu size={18} />
      </button>
      <div className="home-head-text">
        <h1>
          {icon}
          <span className="ellipsis">{title}</span>
        </h1>
        {meta && <div className="home-head-meta">{meta}</div>}
      </div>
      {actions && <div className="home-head-actions">{actions}</div>}
    </header>
  );
}
