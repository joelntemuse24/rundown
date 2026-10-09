import { useState } from 'preact/hooks';
import { postGenerate, relativeTime, type ListedReplay } from './data';
import s from './Home.module.css';

const PR_RE = /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

export function Home({ replays, origin }: { replays: ListedReplay[]; origin: string }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    const value = url.trim();
    if (!PR_RE.test(value)) {
      setError('Paste a pull request link, like https://github.com/owner/repo/pull/123.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await postGenerate({ pr_url: value });
      location.href = new URL(res.url, location.href).pathname + new URL(res.url, location.href).search;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class={s.page}>
      <header class={s.header}>
        <span class={s.brand}>Rundown</span>
      </header>
      <main class={s.main}>
        <h1 class={s.title}>Read what a pull request actually did, in the order it makes sense.</h1>
        <p class={s.lede}>
          Paste a GitHub pull request. Rundown replays the diff as a sequence of steps, with the libraries it leans on, where the logic
          branches, and what the tests lock. It explains; it does not review.
        </p>
        <form class={s.form} onSubmit={submit}>
          <label class={s.label} for="pr">
            Pull request URL
          </label>
          <div class={s.row}>
            <input
              id="pr"
              class={s.input}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellcheck={false}
              placeholder="https://github.com/owner/repo/pull/123"
              value={url}
              onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
              disabled={busy}
            />
            <button class={s.submit} type="submit" disabled={busy || !url.trim()}>
              {busy ? 'Fetching the diff…' : 'Replay'}
            </button>
          </div>
          {error ? (
            <p class={s.error} role="alert">
              {error}
            </p>
          ) : (
            <p class={s.hint}>Public repositories only. Writing a replay can take a minute on the free model.</p>
          )}
        </form>

        <section class={s.list} aria-labelledby="recent">
          <h2 id="recent" class={s.listTitle}>
            Replays on this server
          </h2>
          {replays.length === 0 ? (
            <p class={s.empty}>No replays here yet. The first one you paste will be listed here.</p>
          ) : (
            <ol class={s.items}>
              {replays.slice(0, 50).map((r) => (
                <li key={r.id}>
                  <a class={s.item} href={`/r/${r.id}`}>
                    <span class={s.itemTitle}>{r.title}</span>
                    <span class={s.itemMeta}>
                      {r.label}
                      {r.status !== 'ready' && <> · {r.status === 'pending' ? 'writing' : 'failed'}</>} · {relativeTime(r.created_at)}
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section class={s.agents}>
          <h2 class={s.listTitle}>For agents and hooks</h2>
          <p>
            Add <code>{origin}/mcp</code> as an HTTP MCP server and call <code>explain_change</code> with a <code>pr_url</code>, or{' '}
            <code>POST {origin}/generate</code> with <code>{'{"pr_url": "…"}'}</code>. Both return the replay URL.
          </p>
        </section>
      </main>
    </div>
  );
}
