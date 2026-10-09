import { useEffect, useRef, useState } from 'preact/hooks';
import s from './Viewer.module.css';

declare global {
  interface Window {
    mermaid?: any;
  }
}

let loading: Promise<any> | null = null;

function loadMermaid(src: string): Promise<any> {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  loading ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid missing')));
    el.onerror = () => {
      loading = null;
      reject(new Error('mermaid failed to load'));
    };
    document.head.appendChild(el);
  });
  return loading;
}

let seq = 0;

/** Renders valid Mermaid. A source Mermaid cannot draw is shown as plain text. */
export function Diagram({ source, title, dark, vendorSrc, onNode }: { source: string; title: string; dark: boolean; vendorSrc: string; onNode: (label: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    (async () => {
      try {
        const mermaid = await loadMermaid(vendorSrc);
        const css = getComputedStyle(document.documentElement);
        const v = (n: string) => css.getPropertyValue(n).trim();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: v('--mono'),
          themeVariables: {
            background: v('--bg'),
            primaryColor: v('--bg'),
            primaryTextColor: v('--ink'),
            primaryBorderColor: v('--muted'),
            lineColor: v('--muted'),
            textColor: v('--ink'),
            fontSize: '12px',
          },
          flowchart: { htmlLabels: false, curve: 'basis' },
        });
        if ((await mermaid.parse(source, { suppressErrors: true })) === false) throw new Error('invalid');
        const { svg } = await mermaid.render(`rd-diagram-${++seq}`, source);
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = svg;
        const el = ref.current.querySelector('svg');
        if (el) {
          el.style.maxHeight = '232px';
          el.style.height = 'auto';
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, dark, vendorSrc]);

  if (failed) {
    return (
      <section class={`${s.diagram} ${s.diagramText}`} aria-label={title || 'Call diagram'}>
        {title && <div class={s.diagramTitle}>{title}</div>}
        <pre class={s.diagramPlain}>{source}</pre>
      </section>
    );
  }

  const click = (e: MouseEvent) => {
    const node = (e.target as Element).closest('g.node, g.actor, text.actor');
    const label = node?.textContent?.trim();
    if (label) onNode(label);
  };

  return (
    <section class={s.diagram} aria-label={title || 'Call diagram'}>
      {title && <div class={s.diagramTitle}>{title}</div>}
      <div class={s.diagramCanvas} ref={ref} onClick={click} />
    </section>
  );
}
