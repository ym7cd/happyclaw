import { useEffect, useState } from 'react';

export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      const height = Math.max(0, window.innerHeight - viewport.height);
      setKeyboardHeight(height);
      document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
    };

    viewport.addEventListener('resize', handleResize);
    viewport.addEventListener('scroll', handleResize);
    return () => {
      viewport.removeEventListener('resize', handleResize);
      viewport.removeEventListener('scroll', handleResize);
    };
  }, []);

  return { keyboardHeight, isKeyboardVisible: keyboardHeight > 0 };
}
