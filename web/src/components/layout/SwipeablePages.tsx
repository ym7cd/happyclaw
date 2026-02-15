import { useRef, useState, useCallback, useMemo } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { useMediaQuery } from '../../hooks/useMediaQuery';

export interface TabPageConfig {
  /** Tab path used for navigation, e.g. '/chat' */
  path: string;
  /** Route pattern for matching, e.g. '/chat/:groupFolder?' */
  routePattern: string;
  /** Lazy-loaded page element wrapped in Suspense */
  element: React.ReactNode;
}

interface SwipeablePagesProps {
  pages: TabPageConfig[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
}

/**
 * Renders a tab page within a Routes context so that useParams/useSearchParams
 * work correctly inside the page component.
 *
 * For the current tab, uses the real browser location so route params resolve.
 * For adjacent (prefetch) tabs, uses a synthetic location matching the tab path.
 */
function RoutedPageSlot({ page, isCurrent }: { page: TabPageConfig; isCurrent: boolean }) {
  const realLocation = useLocation();

  // Current tab: use real location so useParams gets real URL params
  // Adjacent tabs: use synthetic location matching the tab's base path
  const slotLocation = isCurrent
    ? realLocation
    : { pathname: page.path, search: '', hash: '', state: null, key: 'default' };

  return (
    <Routes location={slotLocation}>
      <Route path={page.routePattern} element={page.element} />
    </Routes>
  );
}

export function SwipeablePages({ pages, currentIndex, onIndexChange }: SwipeablePagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSwiping, setIsSwiping] = useState(false);
  const [translateX, setTranslateX] = useState(0);
  const touchRef = useRef({ startX: 0, startY: 0, startTime: 0, isHorizontal: null as boolean | null });
  const isMobile = useMediaQuery('(max-width: 1023px)');

  // Track which pages have been visited so we don't unmount them on return
  const visitedRef = useRef<Set<number>>(new Set([currentIndex]));
  visitedRef.current.add(currentIndex);

  // Determine which pages should be mounted: current ± 1 + previously visited
  const mountedIndices = useMemo(() => {
    const set = new Set(visitedRef.current);
    // Always mount current ± 1 for smooth swipe preview
    if (currentIndex > 0) set.add(currentIndex - 1);
    if (currentIndex < pages.length - 1) set.add(currentIndex + 1);
    return set;
  }, [currentIndex, pages.length]);

  // Target translateX when not swiping
  const targetX = -(currentIndex * 100) / pages.length;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      isHorizontal: null,
    };
    setIsSwiping(true);
    setTranslateX(0);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchRef.current.startTime) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchRef.current.startX;
    const deltaY = touch.clientY - touchRef.current.startY;

    // Direction detection (on first significant movement)
    if (touchRef.current.isHorizontal === null) {
      if (Math.abs(deltaX) < 5 && Math.abs(deltaY) < 5) return;
      touchRef.current.isHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 0.577;
      if (!touchRef.current.isHorizontal) {
        setIsSwiping(false);
        return;
      }
    }

    if (!touchRef.current.isHorizontal) return;

    // Edge elasticity
    let adjustedDelta = deltaX;
    if ((currentIndex === 0 && deltaX > 0) || (currentIndex === pages.length - 1 && deltaX < 0)) {
      adjustedDelta = deltaX * 0.3;
    }

    setTranslateX(adjustedDelta);
  }, [currentIndex, pages.length]);

  const handleTouchEnd = useCallback(() => {
    if (!isSwiping || touchRef.current.isHorizontal !== true) {
      setIsSwiping(false);
      setTranslateX(0);
      return;
    }

    const elapsed = Date.now() - touchRef.current.startTime;
    const velocity = Math.abs(translateX) / elapsed;
    const threshold = window.innerWidth * 0.25;

    let newIndex = currentIndex;
    if (translateX < -threshold || (translateX < 0 && velocity > 0.3)) {
      newIndex = Math.min(currentIndex + 1, pages.length - 1);
    } else if (translateX > threshold || (translateX > 0 && velocity > 0.3)) {
      newIndex = Math.max(currentIndex - 1, 0);
    }

    setIsSwiping(false);
    setTranslateX(0);

    if (newIndex !== currentIndex) {
      onIndexChange(newIndex);
    }
  }, [isSwiping, translateX, currentIndex, pages.length, onIndexChange]);

  if (!isMobile) {
    // Desktop: render only the current page with proper route context
    const page = pages[currentIndex];
    return (
      <div className="h-full overflow-auto">
        {page && <RoutedPageSlot page={page} isCurrent />}
      </div>
    );
  }

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    width: `${pages.length * 100}%`,
    height: '100%',
    transform: `translateX(calc(${targetX}% + ${isSwiping ? translateX : 0}px))`,
    transition: isSwiping ? 'none' : 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
    willChange: 'transform',
    backfaceVisibility: 'hidden',
  };

  return (
    <div
      ref={containerRef}
      className="h-full overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div style={containerStyle}>
        {pages.map((page, i) => {
          const shouldMount = mountedIndices.has(i);
          return (
            <div
              key={page.path}
              style={{
                width: `${100 / pages.length}%`,
                flexShrink: 0,
                height: '100%',
                overflow: 'auto',
              }}
            >
              {shouldMount && (
                <RoutedPageSlot page={page} isCurrent={i === currentIndex} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
