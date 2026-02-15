import { NavLink, useLocation } from 'react-router-dom';
import { MessageSquare, Layers, Clock, Activity, Settings } from 'lucide-react';

const navItems = [
  { path: '/chat', icon: MessageSquare, label: '工作台' },
  { path: '/groups', icon: Layers, label: '会话' },
  { path: '/tasks', icon: Clock, label: '任务' },
  { path: '/monitor', icon: Activity, label: '监控' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function BottomTabBar() {
  const location = useLocation();

  return (
    <>
      {/* iOS PWA 底部触摸吸收层 */}
      <div className="pwa-bottom-guard" aria-hidden="true" />

      {/* 悬浮胶囊导航 */}
      <div className="floating-nav-container">
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
