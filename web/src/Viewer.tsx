import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseDiff, parseEvidence, parseLineRange, type DiffFile } from '../../src/diff';
import { DEPTH_SLOTS, DEPTHS, hasChain, visibleSteps, type Step } from '../../src/schema';
import { copyText, postGenerate, type Depth, type Doc } from './data';
import { Diagram } from './Diagram';
import { CollapsedFile, FileHeader, functionEnd, hunkSpan, HunkView, NOISY, type LongFunction } from './DiffView';
import d from './Diff.module.css';
import s from './Viewer.module.css';

// ---------- loading shell ----------

export function Viewer({ id, initial, defaultDepth, exported }: { id?: string; initial?: Doc; defaultDepth: Depth; exported?: boolean }) {
  const [doc, setDoc] = useState<Doc | null>(initial ?? null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (exported || !id) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`/r/${id}.json`);
        if (res.status === 404) throw new Error('There is no replay with this id on this server.');
        if (!res.ok) throw new Error(`The server returned ${res.status}.`);
        const next: Doc = await res.json();
        if (stopped) return;
        setDoc(next);
        setError('');
        if (next.status === 'pending') timer = setTimeout(load, 2000);
      } catch (err) {
        if (stopped) return;
        setError((err as Error).message);
        if (!(err as Error).message.startsWith('There is no')) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, exported]);

  if (!doc) {
    return (
      <Shell>
        <p class={s.status}>{error || 'Loading the replay…'}</p>
        {error && (
          <p class={s.statusSub}>
            <a href="/">Back to the paste field</a>
          </p>
        )}
      </Shell>
    );
  }
  if (doc.status === 'pending') return <Pending doc={doc} />;
  if (doc.status === 'failed' || !doc.replay) return <Failed doc={doc} />;
  return <ReplayView doc={doc} defaultDepth={defaultDepth} exported={!!exported} />;
}

function Shell({ children, label }: { children: ComponentChildren; label?: string }) {
  return (
    <div class={s.shell}>
      <header class={s.topbar}>
        <a class={s.brand} href="/">
          Rundown
        </a>
        {label && <span class={s.sourceLabel}>{label}</span>}
      </header>
      <main class={s.statusMain}>{children}</main>
    </div>
  );
}

function Pending({ doc }: { doc: Doc }) {
  const adds = doc.facts.files.reduce((n, f) => n + f.additions, 0);
  const dels = doc.facts.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <Shell label={doc.source.label}>
      <h1 class={s.statusTitle}>Writing the replay</h1>
      <p class={s.status}>
        The facts are in: {doc.facts.files.length} files, +{adds} −{dels}, {doc.facts.manifest_changes.length} manifest changes,{' '}
        {doc.facts.test_files.length} test files. The model is writing the narrative now. This page updates by itself.
      </p>
      <div class={s.progress} aria-hidden="true" />
    </Shell>
  );
}

function Failed({ doc }: { doc: Doc }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const retry = async () => {
    setBusy(true);
    setErr('');
    try {
      const res = await postGenerate(doc.source.pr_url ? { pr_url: doc.source.pr_url } : { diff: doc.diff });
      location.href = new URL(res.url, location.href).pathname;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Shell label={doc.source.label}>
      <h1 class={s.statusTitle}>Rundown could not write this replay</h1>
      <p class={s.status}>{doc.error || 'The model did not return a valid replay.'}</p>
      <p class={s.statusSub}>The facts were extracted, so nothing is lost by trying again. A second attempt is a new model call.</p>
      <button class={s.button} onClick={retry} disabled={busy}>
        {busy ? 'Starting…' : 'Try again'}
      </button>
      {err && <p class={s.statusErr}>{err}</p>}
    </Shell>
  );
}

// ---------- replay ----------

function useWide(query = '(min-width: 901px)') {
  const [wide, setWide] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return wide;
}

const SOURCE_MARK = { pr_body: 'from the PR body', commits: 'from the commit messages', inferred: 'inferred' } as const;
const IMPORTANCE_MARK = { critical: 'C', important: 'I', supporting: 'S' } as const;

function flash(selector: string) {
  const els = document.querySelectorAll(selector);
  els.forEach((el) => {
    el.classList.remove('rd-flash');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('rd-flash');
    setTimeout(() => el.classList.remove('rd-flash'), 1200);
  });
}

function ReplayView({ doc, defaultDepth, exported }: { doc: Doc; defaultDepth: Depth; exported: boolean }) {
  const replay = doc.replay!;
  const facts = doc.facts;
  const files = useMemo(() => parseDiff(doc.diff), [doc.diff]);
  const fileMap = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);

  const [depth, setDepthState] = useState<Depth>(() => {
    const q = new URLSearchParams(location.search).get('depth') as Depth | null;
    return q && DEPTHS.includes(q) ? q : defaultDepth;
  });
  const [stepId, setStepId] = useState<string>(() => location.hash.slice(1) || '');
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const [compact, setCompact] = useState(() => localStorage.getItem('rundown-density') === 'compact');
  const [showDiagram, setShowDiagram] = useState(true);
  const [split, setSplit] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [help, setHelp] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [otherOpen, setOtherOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [jump, setJump] = useState<{ path: string; line: number; n: number } | null>(null);
  const wide = useWide();
  const mainRef = useRef<HTMLElement>(null);

  const slots = DEPTH_SLOTS[depth];
  const steps = useMemo(() => visibleSteps(replay.sequence, depth), [replay, depth]);
  const current = steps.find((x) => x.id === stepId) ?? steps[0];
  const currentIdx = steps.indexOf(current);
  const chain = useMemo(() => hasChain(facts.call_edges), [facts]);
  const diagramAvailable = !!replay.diagram.mermaid.trim() && (depth === 'deep' || (depth === 'median' && chain));

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('rundown-theme', dark ? 'dark' : 'light');
    } catch {}
  }, [dark]);
  useEffect(() => {
    document.documentElement.dataset.density = compact ? 'compact' : 'comfortable';
    try {
      localStorage.setItem('rundown-density', compact ? 'compact' : 'comfortable');
    } catch {}
  }, [compact]);
  useEffect(() => {
    document.title = `${replay.intent.text} · Rundown`;
  }, [replay]);

  const setDepth = (next: Depth) => {
    setDepthState(next);
    if (!exported) {
      const u = new URL(location.href);
      u.searchParams.set('depth', next);
      history.replaceState(null, '', u);
    }
  };
  const selectStep = (st: Step) => {
    setStepId(st.id);
    setRevealed(new Set());
    setOtherOpen(false);
    if (!exported) history.replaceState(null, '', `${location.pathname}${location.search}#${st.id}`);
  };

  const say = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((m) => (m === msg ? '' : m)), 2200);
  };

  /** Hunks a step cites: those overlapping its line ranges, plus those its logic notes point into. */
  const citedHunks = useCallback(
    (st: Step) => {
      const out = new Map<string, Set<number>>();
      const add = (path: string, a: number, b: number) => {
        const f = fileMap.get(path);
        if (!f) return;
        f.hunks.forEach((h, i) => {
          const [ha, hb] = hunkSpan(f, h);
          if (a <= hb && b >= ha) {
            if (!out.has(path)) out.set(path, new Set());
            out.get(path)!.add(i);
          }
        });
        if (!out.has(path)) out.set(path, new Set());
      };
      for (const sf of st.files) {
        const r = parseLineRange(sf.lines);
        if (r) add(sf.path, r[0], r[1]);
      }
      for (const l of replay.logic.filter((x) => x.step_id === st.id)) {
        const e = parseEvidence(l.evidence);
        if (e && out.has(e.path)) add(e.path, e.line, e.line);
      }
      return out;
    },
    [fileMap, replay],
  );

  const stepCites = (st: Step, path: string, line: number) => {
    const f = fileMap.get(path);
    const set = citedHunks(st).get(path);
    if (!f || !set) return false;
    return [...set].some((i) => {
      const [a, b] = hunkSpan(f, f.hunks[i]);
      return line >= a && line <= b;
    });
  };

  const jumpTo = (ev: string) => {
    const e = parseEvidence(ev);
    if (!e) return;
    if (!stepCites(current, e.path, e.line)) {
      const owner = steps.find((st) => stepCites(st, e.path, e.line));
      if (owner) {
        setStepId(owner.id);
        setRevealed(new Set());
      } else {
        setRevealed((r) => new Set(r).add(e.path));
        setOtherOpen(true);
      }
    }
    setJump({ path: e.path, line: e.line, n: Date.now() });
  };

  useEffect(() => {
    if (!jump) return;
    const id = requestAnimationFrame(() => {
      const sel = `[data-loc="${CSS.escape(`${jump.path}:${jump.line}`)}"]`;
      let el = document.querySelector(sel);
      if (!el) {
        const covers = [...document.querySelectorAll<HTMLElement>('[data-covers]')].find((x) => {
          const m = /^(.*):(\d+)-(\d+)$/.exec(x.dataset.covers!);
          return m && m[1] === jump.path && jump.line >= +m[2] && jump.line <= +m[3];
        });
        el = covers ?? document.querySelector(`[data-file="${CSS.escape(jump.path)}"]`);
      }
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (el.matches('[data-loc]')) flash(sel);
      else (el as HTMLElement).classList.add('rd-flash'), setTimeout(() => el!.classList.remove('rd-flash'), 1200);
    });
    return () => cancelAnimationFrame(id);
  }, [jump]);

  const exportFile = async () => {
    if (exported) return;
    try {
      const res = await fetch('/export', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/html' }, body: JSON.stringify({ id: doc.id, depth }) });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `rundown-${doc.id}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say('Exported one HTML file');
    } catch {
      say('Export failed');
    }
  };
  const copyLink = async () => say((await copyText(location.href)) ? 'Link copied' : 'Could not copy');

  const copyForAgent = async (st: Step) => {
    const selected = window.getSelection()?.toString().trim() || '';
    const sf = st.files[0];
    const evidence = sf ? `${sf.path}:${parseLineRange(sf.lines)?.[0] ?? sf.lines}` : '';
    const text = `In the Rundown replay of ${doc.id}, step ${st.id} says: ${st.summary}\nEvidence: ${evidence}\nDisagree: ${selected}`;
    say((await copyText(text)) ? 'Copied for your agent' : 'Could not copy');
  };

  const onNode = (label: string) => {
    const fn = facts.functions_touched.find((f) => f.name === label || `${f.path}:${f.name}` === label);
    const target = fn ? steps.find((st) => stepCites(st, fn.path, fn.line)) ?? steps.find((st) => st.files.some((x) => x.path === fn.path)) : undefined;
    if (target) {
      selectStep(target);
      mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Keys stay unbound while any text field has focus.
  const keyState = { steps, currentIdx, depth, help, exportFile, copyLink };
  const keyRef = useRef(keyState);
  keyRef.current = keyState;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const k = keyRef.current;
      if (k.help && (e.key === 'Escape' || e.key === '?')) return setHelp(false);
      switch (e.key) {
        case 'j':
          if (k.currentIdx < k.steps.length - 1) selectStep(k.steps[k.currentIdx + 1]);
          break;
        case 'k':
          if (k.currentIdx > 0) selectStep(k.steps[k.currentIdx - 1]);
          break;
        case '[':
          setDepth(DEPTHS[Math.max(0, DEPTHS.indexOf(k.depth) - 1)]);
          break;
        case ']':
          setDepth(DEPTHS[Math.min(2, DEPTHS.indexOf(k.depth) + 1)]);
          break;
        case 'd':
          setDark((x) => !x);
          break;
        case '?':
          setHelp(true);
          break;
        case 'e':
          k.exportFile();
          break;
        case 'y':
          k.copyLink();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const stale = doc.source.kind === 'pr' && doc.current_head && facts.head && doc.current_head !== facts.head;
  const [regen, setRegen] = useState('');
  const regenerate = async () => {
    setRegen('Starting…');
    try {
      const res = await postGenerate({ pr_url: doc.source.pr_url });
      location.href = new URL(res.url, location.href).pathname;
    } catch (e) {
      setRegen((e as Error).message);
    }
  };

  const editorHref = (path: string, line = 1) => (doc.source.kind === 'local' && doc.source.root ? `vscode://file${doc.source.root}/${path}:${line}` : undefined);
  const Cite = ({ ev }: { ev: string }) => (
    <button class={s.cite} title={ev} onClick={() => jumpTo(ev)}>
      {ev}
    </button>
  );

  // ---------- step column ----------

  const cited = citedHunks(current);
  const stepLogic = slots.logic ? replay.logic.filter((l) => l.step_id === current.id) : [];
  const fnNotes = new Map(replay.functions.map((f) => [`${f.path}:${f.name}`, f.note]));
  const longFnsFor = (f: DiffFile): LongFunction[] =>
    facts.functions_touched
      .filter((t) => t.path === f.path && t.status === 'added')
      .flatMap((t) => {
        const h = f.hunks.find((x) => t.line >= x.newStart && t.line < x.newStart + x.newLines);
        if (!h) return [];
        const end = functionEnd(h, t.line);
        return end - t.line + 1 > 40 ? [{ name: t.name, start: t.line, end, note: fnNotes.get(`${t.path}:${t.name}`) ?? '' }] : [];
      });

  const renderFile = (f: DiffFile, indices: Set<number>, isCited: boolean) => {
    const restOpen = revealed.has(f.path);
    const shown = f.hunks.map((h, i) => ({ h, i })).filter(({ i }) => indices.has(i) || restOpen);
    const hidden = f.hunks.length - shown.length;
    const longFns = longFnsFor(f);
    return (
      <div class={d.file} data-file={f.path} key={f.path}>
        <FileHeader f={f} editorHref={editorHref(f.path, f.hunks[0]?.newStart)} />
        {NOISY(f.path) ? (
          <CollapsedFile f={f} cited={isCited} />
        ) : (
          <>
            {shown.map(({ h, i }) => {
              const [a, b] = hunkSpan(f, h);
              const notes = stepLogic.filter((l) => {
                const e = parseEvidence(l.evidence);
                return e && e.path === f.path && e.line >= a && e.line <= b;
              });
              return (
                <HunkView key={i} f={f} h={h} split={split && wide} longFns={longFns}>
                  {notes.map((l) => (
                    <aside class={s.note} key={l.id}>
                      <p class={s.noteText}>
                        {l.summary} <Cite ev={l.evidence} />
                      </p>
                      {l.failure_mode && (
                        <p class={s.noteFail}>
                          <span class={s.noteLabel}>If it fails</span> {l.failure_mode}
                        </p>
                      )}
                    </aside>
                  ))}
                </HunkView>
              );
            })}
            {hidden > 0 && (
              <button class={s.textButton} onClick={() => setRevealed((r) => new Set(r).add(f.path))}>
                Rest of this file ({hidden} more {hidden === 1 ? 'hunk' : 'hunks'})
              </button>
            )}
          </>
        )}
      </div>
    );
  };

  const citedFiles = [...cited.keys()].map((p) => fileMap.get(p)).filter((f): f is DiffFile => !!f);
  const otherFiles = files.filter((f) => !cited.has(f.path));
  const deps = replay.dependencies;
  const tests = replay.tests;
  const showRail = railOpen;

  return (
    <div class={s.page}>
      <header class={s.header}>
        <div class={s.topbar}>
          <a class={s.brand} href={exported ? undefined : '/'}>
            Rundown
          </a>
          {doc.source.pr_url ? (
            <a class={s.sourceLabel} href={doc.source.pr_url} target="_blank" rel="noreferrer">
              {doc.source.label}
            </a>
          ) : (
            <span class={s.sourceLabel}>{doc.source.label}</span>
          )}
        </div>
        <h1 class={s.intent}>{replay.intent.text}</h1>
        <div class={s.controls}>
          <span class={s.sourceMark}>{SOURCE_MARK[replay.intent.source]}</span>
          <div class={s.segmented} role="group" aria-label="Depth">
            {DEPTHS.map((x) => (
              <button key={x} aria-pressed={depth === x} class={depth === x ? s.segOn : s.seg} onClick={() => setDepth(x)}>
                {x[0].toUpperCase() + x.slice(1)}
              </button>
            ))}
          </div>
          <button class={s.control} aria-pressed={compact} onClick={() => setCompact(!compact)}>
            {compact ? 'Compact' : 'Comfortable'}
          </button>
          {diagramAvailable && (
            <button class={s.control} aria-pressed={showDiagram} onClick={() => setShowDiagram(!showDiagram)}>
              {showDiagram ? 'Hide diagram' : 'Show diagram'}
            </button>
          )}
          {wide && (
            <button class={s.control} aria-pressed={split} onClick={() => setSplit(!split)}>
              {split ? 'Side by side' : 'Unified'}
            </button>
          )}
          <span class={s.spacer} />
          {!exported && (
            <button class={s.control} onClick={exportFile}>
              Export
            </button>
          )}
          <button class={s.control} onClick={copyLink}>
            Copy link
          </button>
          <span class={s.notice} role="status" aria-live="polite">
            {notice}
          </span>
        </div>
        {stale && (
          <div class={s.banner}>
            This pull request has moved to <code>{doc.current_head!.slice(0, 7)}</code> since this replay was written.{' '}
            <button class={s.textButtonInline} onClick={regenerate} disabled={!!regen && regen === 'Starting…'}>
              Regenerate
            </button>
            {regen && regen !== 'Starting…' && <span class={s.bannerErr}> {regen}</span>}
          </div>
        )}
      </header>

      {diagramAvailable && showDiagram && (
        <Diagram
          source={replay.diagram.mermaid}
          title={replay.diagram.title}
          dark={dark}
          vendorSrc={exported ? './rundown-vendor/mermaid.min.js' : '/vendor/mermaid.min.js'}
          onNode={onNode}
        />
      )}

      <div class={`${s.layout} ${showRail ? '' : s.railClosed}`}>
        <nav class={s.sequence} aria-label="Sequence">
          <ol class={s.steps}>
            {steps.map((st, i) => (
              <li key={st.id}>
                <button
                  class={`${s.stepLink} ${st.id === current.id ? s.stepOn : ''} ${st.importance === 'supporting' ? s.quiet : ''}`}
                  aria-current={st.id === current.id ? 'step' : undefined}
                  onClick={() => selectStep(st)}
                >
                  <span class={s.stepNum}>{i + 1}</span>
                  <span class={s.stepTitle}>{st.title}</span>
                  <span class={s.mark} title={st.importance}>
                    {IMPORTANCE_MARK[st.importance]}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <main class={s.main} ref={mainRef}>
          <div class={s.stepHead}>
            <span class={s.stepCount}>
              Step {currentIdx + 1} of {steps.length} · <span title={current.importance}>{IMPORTANCE_MARK[current.importance]}</span>
            </span>
            <h2 class={s.stepHeading}>{current.title}</h2>
            {slots.narrative && <p class={s.summary}>{current.summary}</p>}
          </div>

          {citedFiles.map((f) => renderFile(f, cited.get(f.path)!, true))}

          {otherFiles.length > 0 && (
            <div class={s.others}>
              <button class={s.textButton} aria-expanded={otherOpen} onClick={() => setOtherOpen(!otherOpen)}>
                {otherOpen ? 'Hide' : 'Files not in this step'} ({otherFiles.length})
              </button>
              {otherOpen && (
                <div class={s.otherList}>
                  {otherFiles.map((f) =>
                    revealed.has(f.path) ? (
                      renderFile(f, new Set(), false)
                    ) : (
                      <div class={d.file} data-file={f.path} key={f.path}>
                        <FileHeader
                          f={f}
                          extra={
                            <button class={s.textButtonInline} onClick={() => setRevealed((r) => new Set(r).add(f.path))}>
                              show
                            </button>
                          }
                        />
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          )}

          <div class={s.stepFoot}>
            <button class={s.textButton} disabled={currentIdx === 0} onClick={() => selectStep(steps[currentIdx - 1])}>
              ← Previous
            </button>
            <button class={s.textButton} onClick={() => copyForAgent(current)} title="Copies this step with any text you have selected">
              Copy for agent
            </button>
            <button class={s.textButton} disabled={currentIdx === steps.length - 1} onClick={() => selectStep(steps[currentIdx + 1])}>
              Next →
            </button>
          </div>
        </main>

        <aside class={s.rail} aria-label="Dependencies, tests, and questions">
          <button class={s.railToggle} onClick={() => setRailOpen(!railOpen)} aria-expanded={railOpen}>
            {railOpen ? 'Hide notes' : 'Notes'}
          </button>
          {showRail && (
            <div class={s.railBody}>
              <section class={s.railSection}>
                <h3 class={s.railTitle}>Dependencies</h3>
                {deps.length === 0 ? (
                  <p class={s.railEmpty}>No dependency changes in the diff.</p>
                ) : (
                  deps.map((dep) => (
                    <div class={s.railItem} key={dep.name}>
                      <div class={s.depName}>
                        <code>{dep.name}</code> <span class={s.muted}>{dep.change}</span>
                      </div>
                      <p class={s.railText}>{dep.why}</p>
                      <Cite ev={dep.evidence} />
                    </div>
                  ))
                )}
              </section>
              <section class={s.railSection}>
                <h3 class={s.railTitle}>Tests</h3>
                {tests.length === 0 ? (
                  <p class={s.railEmpty}>No test files in the diff.</p>
                ) : (
                  tests.map((t) => (
                    <div class={s.railItem} key={t.file}>
                      <div class={s.depName}>
                        <code>{t.file}</code>
                      </div>
                      <p class={s.railText}>
                        <span class={s.noteLabel}>Locks</span> {t.locks}
                      </p>
                      {slots.narrative && t.does_not_cover && (
                        <p class={s.railText}>
                          <span class={s.noteLabel}>Does not cover</span> {t.does_not_cover}
                        </p>
                      )}
                      <Cite ev={t.evidence} />
                    </div>
                  ))
                )}
              </section>
              {slots.questions && replay.open_questions.length > 0 && (
                <section class={s.railSection}>
                  <h3 class={s.railTitle}>Open questions</h3>
                  {replay.open_questions.map((q, i) => (
                    <div class={s.railItem} key={i}>
                      <p class={s.railText}>{q.text}</p>
                      <Cite ev={q.evidence} />
                    </div>
                  ))}
                </section>
              )}
              {slots.functions && replay.functions.length > 0 && (
                <section class={s.railSection}>
                  <h3 class={s.railTitle}>Changed functions</h3>
                  {replay.functions.map((f) => (
                    <div class={s.railItem} key={`${f.path}:${f.name}`}>
                      <div class={s.depName}>
                        <code>{f.name}</code>
                      </div>
                      <p class={s.railText}>{f.note}</p>
                      <Cite ev={f.evidence} />
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}
        </aside>
      </div>

      <footer class={s.footer}>
        <span>
          {facts.files.length} files · base {facts.base ? facts.base.slice(0, 7) : '—'} · head {facts.head ? facts.head.slice(0, 7) : '—'} · {doc.model}
        </span>
        <button class={s.textButtonInline} onClick={() => setHelp(true)}>
          Keyboard: ?
        </button>
      </footer>

      {help && (
        <div class={s.overlay} onClick={() => setHelp(false)}>
          <div class={s.help} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
            <h2 class={s.helpTitle}>Keyboard</h2>
            <dl class={s.keys}>
              {[
                ['j / k', 'next / previous step'],
                ['[ / ]', 'less / more depth'],
                ['d', 'dark paper'],
                ['e', 'export one HTML file'],
                ['y', 'copy this URL'],
                ['?', 'this list'],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <button class={s.textButton} onClick={() => setHelp(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
