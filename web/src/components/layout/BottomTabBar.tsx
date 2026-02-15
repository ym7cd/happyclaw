import { NavLink, useLocation } from 'react-router-dom';
import { MessageSquare, Clock, Activity, Settings } from 'lucide-react';
import { useScrollDirection } from '../../hooks/useScrollDirection';

export const navItems = [
  { path: '/chat', icon: MessageSquare, label: '工作台' },
  { path: '/tasks', icon: Clock, label: '任务' },
  { path: '/monitor', icon: Activity, label: '监控' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function BottomTabBar() {
  const location = useLocation();
  const scrollDir = useScrollDirection();
  const isCompact = scrollDir === 'down';

  return (
    <>
      <div className="pwa-bottom-guard" aria-hidden="true" />
      <div className={`floating-nav-container ${isCompact ? 'compact' : ''}`}>
        <nav className="floating-nav">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = location.pathname.startsWith(path);
            return (
              <NavLink
                key={path}
                to={path}
                replace
                className={`floating-nav-item ${isActive ? 'active' : ''}`}
                aria-label={label}
              >
                <Icon className="w-5 h-5" />
              </NavLink>
            );
          })}
        </nav>
      </div>
    </>
  );
}
