import { useEffect, useState } from 'preact/hooks';

/** Hash router: "#/garden/3" -> ["garden", "3"]. Hash routing keeps deep links working behind any static server. */
export function parseHash(h = location.hash): string[] {
  return h.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const navigate = (path: string) => { location.hash = path.startsWith('#') ? path : `#${path}`; };

export function queryParam(name: string): string | null {
  const q = location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get(name) : null;
}
