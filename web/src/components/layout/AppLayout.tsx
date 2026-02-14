import { Outlet, useLocation } from 'react-router-dom';
import { NavRail } from './NavRail';
import { BottomTabBar } from './BottomTabBar';

export function AppLayout() {
  const location = useLocation();
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      {/* Desktop: Left NavRail */}
      <div className="hidden lg:block h-full">
        <NavRail />
      </div>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto lg:pb-0">
        <Outlet />
      </main>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
