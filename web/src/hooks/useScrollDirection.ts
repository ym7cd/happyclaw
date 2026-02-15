import { useState, useEffect, useRef } from 'react';

export function useScrollDirection(scrollRef?: React.RefObject<HTMLElement | null>): 'up' | 'down' | null {
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const lastScrollTop = useRef(0);
  const ticking = useRef(false);

  useEffect(() => {
    // If a specific scrollRef is provided, use that element.
    // Otherwise fall back to window scroll (works even when main has overflow-hidden).
    const el = scrollRef?.current ?? null;
    const threshold = 20;

    const updateDirection = () => {
      const scrollTop = el ? el.scrollTop : window.scrollY;
      const diff = scrollTop - lastScrollTop.current;

      if (Math.abs(diff) > threshold) {
        setDirection(diff > 0 ? 'down' : 'up');
        lastScrollTop.current = scrollTop;
      }
      ticking.current = false;
    };

    const onScroll = () => {
      if (!ticking.current) {
        requestAnimationFrame(updateDirection);
        ticking.current = true;
      }
    };

    const target: EventTarget = el ?? window;
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  return direction;
}
