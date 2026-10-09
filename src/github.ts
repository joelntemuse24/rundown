export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PullData extends PullRef {
  url: string;
  title: string;
  body: string;
  base: string;
  head: string;
  commits: string[];
  diff: string;
}

export class GitHubError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export function parsePrUrl(url: string): PullRef | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

const API = () => process.env.GITHUB_API_URL || 'https://api.github.com';

async function gh(path: string, token: string | undefined, accept = 'application/vnd.github+json'): Promise<Response> {
  const res = await fetch(API() + path, {
    headers: {
      accept,
      'user-agent': 'rundown',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? 'Pull request not found. Private repositories need a GitHub token.'
        : res.status === 401
          ? 'GitHub rejected the token.'
          : res.status === 403 || res.status === 429
            ? 'GitHub rate limit reached. Try again later or send a token.'
            : `GitHub API returned ${res.status}.`;
    throw new GitHubError(hint, res.status);
  }
  return res;
}

export async function fetchPull(ref: PullRef, token?: string): Promise<PullData> {
  const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const [meta, diff, commits] = await Promise.all([
    gh(base, token).then((r) => r.json() as Promise<any>),
    gh(base, token, 'application/vnd.github.v3.diff').then((r) => r.text()),
    gh(`${base}/commits?per_page=100`, token).then((r) => r.json() as Promise<any[]>),
  ]);
  return {
    ...ref,
    url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    title: meta.title ?? '',
    body: meta.body ?? '',
    base: meta.base?.sha ?? '',
    head: meta.head?.sha ?? '',
    commits: commits.map((c) => String(c.commit?.message ?? '').split('\n')[0]).filter(Boolean),
    diff,
  };
}

export async function fetchHead(ref: PullRef, token?: string): Promise<string> {
  const meta: any = await (await gh(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, token)).json();
  return meta.head?.sha ?? '';
}
