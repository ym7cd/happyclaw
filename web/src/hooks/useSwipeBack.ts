import { useRef, useCallback, useEffect } from 'react';
import { useMediaQuery } from './useMediaQuery';

interface SwipeBackOptions {
  edgeWidth?: number;
  threshold?: number;
}

export function useSwipeBack(
  containerRef: React.RefObject<HTMLElement | null>,
  onBack: () => void,
  options: SwipeBackOptions = {}
) {
  const { edgeWidth = 30, threshold = 0.4 } = options;
  const isMobile = useMediaQuery('(max-width: 1023px)');
  const touchRef = useRef({ startX: 0, startY: 0, active: false, currentX: 0 });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const touch = e.touches[0];
    if (touch.clientX < edgeWidth) {
      touchRef.current = { startX: touch.clientX, startY: touch.clientY, active: true, currentX: 0 };
    }
  }, [edgeWidth]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!touchRef.current.active) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchRef.current.startX;
    const deltaY = touch.clientY - touchRef.current.startY;

    // Cancel if vertical
    if (Math.abs(deltaY) > Math.abs(deltaX) && deltaX < 10) {
      touchRef.current.active = false;
      if (containerRef.current) {
        containerRef.current.style.transform = '';
        containerRef.current.style.transition = '';
      }
      return;
    }

    if (deltaX > 0 && containerRef.current) {
      touchRef.current.currentX = deltaX;
      containerRef.current.style.transition = 'none';
      containerRef.current.style.transform = `translateX(${deltaX}px)`;
      containerRef.current.style.willChange = 'transform';
    }
  }, [containerRef]);

  const handleTouchEnd = useCallback(() => {
    if (!touchRef.current.active) return;
    touchRef.current.active = false;

    const el = containerRef.current;
    if (!el) return;

    const swipeDistance = touchRef.current.currentX;
    const screenWidth = window.innerWidth;

    if (swipeDistance > screenWidth * threshold) {
      // Swipe out
      el.style.transition = 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.transform = `translateX(${screenWidth}px)`;
      timeoutRef.current = setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.style.transform = '';
          containerRef.current.style.transition = '';
          containerRef.current.style.willChange = '';
        }
        onBack();
      }, 250);
    } else {
      // Snap back
      el.style.transition = 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.transform = 'translateX(0)';
      const snapTimeout = setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.style.transition = '';
          containerRef.current.style.willChange = '';
        }
      }, 250);
      timeoutRef.current = snapTimeout;
    }
  }, [containerRef, threshold, onBack]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isMobile) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd);

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [containerRef, isMobile, handleTouchStart, handleTouchMove, handleTouchEnd]);
}
