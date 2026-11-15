import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

// One deterministic in-memory store is shared by REST, GraphQL (next pass), MCP and git.
const OWNER = "adaiversen";
const JSON_TYPE = "application/json; charset=utf-8";
let sequence = 0,
  next = 1;
type File = { bytes: Buffer; sha: string };
type Commit = {
  sha: string;
  message: string;
  files: Map<string, File>;
  parent?: string;
};
type Issue = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: Label[];
  comments: { id: number; body: string }[];
  order: number;
};
type Label = { id: number; name: string; color: string };
type Pull = {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  head: string;
  base: string;
  merged: boolean;
  merge?: string;
};
type Repo = {
  id: number;
  name: string;
  description: string;
  private: boolean;
  branch: Map<string, string>;
  commits: Map<string, Commit>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  issueNo: number;
  pullNo: number;
};
const repos = new Map<string, Repo>();
const sha = (x: Buffer | string) => createHash("sha1").update(x).digest("hex");
const repoKey = (name: string) => `${OWNER}/${name}`;
const string = (x: unknown, fallback = "") =>
  typeof x === "string" ? x : fallback;
function reply(
  res: ServerResponse,
  code: number,
  value?: unknown,
  more: Record<string, string> = {},
): void {
  const h = { "x-github-request-id": `forge-${++sequence}`, ...more };
  if (value === undefined) {
    res.writeHead(code, h);
    return res.end();
  }
  const text = JSON.stringify(value) + "\n";
  res.writeHead(code, {
    ...h,
    "content-type": JSON_TYPE,
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}
function fail(res: ServerResponse, code: number, message: string): void {
  reply(res, code, { message });
}
function repoView(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    node_id: `R_${r.id}`,
    name: r.name,
    full_name: repoKey(r.name),
    private: r.private,
    description: r.description,
    default_branch: "main",
    owner: { login: OWNER, id: 1000 },
  };
}
function issueView(i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    node_id: `I_${i.id}`,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels,
    user: { login: OWNER, id: 1000 },
    created_at: `2026-01-01T00:00:${String(i.order).padStart(2, "0")}Z`,
  };
}
function pullView(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    node_id: `PR_${p.id}`,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    merged_at: p.merged ? "2026-01-01T00:00:00Z" : null,
    merge_commit_sha: p.merge ?? null,
    head: { ref: p.head, sha: r.branch.get(p.head) ?? "" },
    base: { ref: p.base, sha: r.branch.get(p.base) ?? "" },
  };
}
function createRepo(name: string, description = "", isPrivate = false): Repo {
  const r: Repo = {
    id: next++,
    name,
    description,
    private: isPrivate,
    branch: new Map(),
    commits: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    issueNo: 1,
    pullNo: 1,
  };
  repos.set(repoKey(name), r);
  return r;
}
function current(r: Repo, branch = "main"): Commit | undefined {
  const s = r.branch.get(branch) ?? branch;
  return r.commits.get(s);
}
function makeCommit(
  r: Repo,
  branch: string,
  message: string,
  edit: (files: Map<string, File>) => void,
): Commit {
  const old = current(r, branch);
  const files = new Map(old?.files ?? []);
  edit(files);
  const material = [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, f]) => `${p}\0${f.sha}`)
    .join("\n");
  const c: Commit = {
    sha: sha(`${old?.sha ?? ""}\0${message}\0${material}`),
    message,
    files,
    parent: old?.sha,
  };
  r.commits.set(c.sha, c);
  r.branch.set(branch, c.sha);
  return c;
}
async function body(
  req: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  const parts: Buffer[] = [];
  for await (const part of req)
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  try {
    const x = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    return x && typeof x === "object" && !Array.isArray(x) ? x : undefined;
  } catch {
    return undefined;
  }
}
function auth(req: IncomingMessage): boolean {
  return (
    req.headers.authorization ===
    `Bearer ${process.env.MAKEFUN_SHOP_TOKEN ?? ""}`
  );
}
function url(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://forge");
}

async function contents(
  req: IncomingMessage,
  res: ServerResponse,
  r: Repo,
  path: string,
  u: URL,
): Promise<void> {
  const method = req.method ?? "GET",
    branch = u.searchParams.get("ref") ?? "main";
  if (method === "GET") {
    const c = current(r, branch);
    const f = c?.files.get(path);
    if (f)
      return reply(res, 200, {
        type: "file",
        encoding: "base64",
        size: f.bytes.length,
        name: path.split("/").at(-1),
        path,
        sha: f.sha,
        content: f.bytes.toString("base64"),
      });
    const prefix = path ? `${path.replace(/\/$/, "")}/` : "";
    const values = [...(c?.files ?? new Map())]
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, v]) => ({
        type: "file",
        name: p.slice(prefix.length),
        path: p,
        sha: v.sha,
        size: v.bytes.length,
      }));
    return values.length
      ? reply(res, 200, values)
      : fail(res, 404, "Not Found");
  }
  const b = await body(req);
  if (!b) return fail(res, 400, "Invalid JSON");
  const active = current(r, string(b.branch, "main")),
    old = active?.files.get(path);
  if (method === "PUT") {
    if (b.sha !== undefined && string(b.sha) !== old?.sha)
      return fail(res, 409, "SHA does not match");
    const bytes = Buffer.from(string(b.content), "base64"),
      file = { bytes, sha: sha(`blob ${bytes.length}\0${bytes}`) };
    const c = makeCommit(
      r,
      string(b.branch, "main"),
      string(b.message, "update file"),
      (files) => files.set(path, file),
    );
    return reply(res, old ? 200 : 201, {
      content: {
        name: path.split("/").at(-1),
        path,
        sha: file.sha,
        size: bytes.length,
        encoding: "base64",
        content: bytes.toString("base64"),
      },
      commit: { sha: c.sha, message: c.message },
    });
  }
  if (method === "DELETE") {
    if (!old) return fail(res, 404, "Not Found");
    if (b.sha !== undefined && string(b.sha) !== old.sha)
      return fail(res, 409, "SHA does not match");
    const c = makeCommit(
      r,
      string(b.branch, "main"),
      string(b.message, "delete file"),
      (files) => files.delete(path),
    );
    return reply(res, 200, { commit: { sha: c.sha, message: c.message } });
  }
  return fail(res, 404, "Not Found");
}
async function issues(
  req: IncomingMessage,
  res: ServerResponse,
  r: Repo,
  tail: string[],
  u: URL,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!tail.length) {
    if (method === "GET") {
      const state = u.searchParams.get("state") ?? "open",
        asc = u.searchParams.get("direction") === "asc";
      const list = r.issues
        .filter((x) => state === "all" || x.state === state)
        .sort((a, b) => (asc ? a.order - b.order : b.order - a.order));
      return reply(res, 200, list.map(issueView));
    }
    if (method === "POST") {
      const b = await body(req);
      if (!b || !string(b.title)) return fail(res, 400, "Invalid JSON");
      const names = Array.isArray(b.labels) ? b.labels.map(String) : [],
        labels = names.map((x) => r.labels.get(x));
      if (labels.some((x) => !x)) return fail(res, 422, "Validation Failed");
      const i: Issue = {
        id: next++,
        number: r.issueNo++,
        title: string(b.title),
        body: string(b.body),
        state: "open",
        labels: labels as Label[],
        comments: [],
        order: next,
      };
      r.issues.push(i);
      return reply(res, 201, issueView(i));
    }
  }
  const i = r.issues.find((x) => x.number === Number(tail[0]));
  if (!i) return fail(res, 404, "Not Found");
  if (tail[1] === "comments") {
    if (method === "GET") return reply(res, 200, i.comments);
    if (method === "POST") {
      const b = await body(req);
      if (!b) return fail(res, 400, "Invalid JSON");
      const c = { id: next++, body: string(b.body) };
      i.comments.push(c);
      return reply(res, 201, c);
    }
  }
  if (method === "GET") return reply(res, 200, issueView(i));
  if (method === "PATCH") {
    const b = await body(req);
    if (!b) return fail(res, 400, "Invalid JSON");
    if (b.state === "open" || b.state === "closed") i.state = b.state;
    return reply(res, 200, issueView(i));
  }
  return fail(res, 404, "Not Found");
}
async function pulls(
  req: IncomingMessage,
  res: ServerResponse,
  r: Repo,
  tail: string[],
  u: URL,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!tail.length) {
    if (method === "GET") {
      const state = u.searchParams.get("state") ?? "open";
      return reply(
        res,
        200,
        r.pulls
          .filter((x) => state === "all" || x.state === state)
          .map((x) => pullView(r, x)),
      );
    }
    if (method === "POST") {
      const b = await body(req);
      if (
        !b ||
        !r.branch.has(string(b.head)) ||
        !r.branch.has(string(b.base, "main"))
      )
        return fail(res, 422, "Validation Failed");
      const p: Pull = {
        id: next++,
        number: r.pullNo++,
        title: string(b.title),
        body: string(b.body),
        state: "open",
        head: string(b.head),
        base: string(b.base, "main"),
        merged: false,
      };
      r.pulls.push(p);
      return reply(res, 201, pullView(r, p));
    }
  }
  const p = r.pulls.find((x) => x.number === Number(tail[0]));
  if (!p) return fail(res, 404, "Not Found");
  if (tail[1] === "files" && method === "GET") {
    const a = current(r, p.base)?.files ?? new Map(),
      b = current(r, p.head)?.files ?? new Map(),
      names = new Set([...a.keys(), ...b.keys()]);
    return reply(
      res,
      200,
      [...names]
        .filter((n) => a.get(n)?.sha !== b.get(n)?.sha)
        .map((n) => ({
          filename: n,
          status: a.has(n) ? (b.has(n) ? "modified" : "removed") : "added",
          additions: b.has(n) ? 1 : 0,
          deletions: a.has(n) && !b.has(n) ? 1 : 0,
          changes: 1,
        })),
    );
  }
  if (tail[1] === "merge" && method === "PUT") {
    if (p.state !== "open" || !current(r, p.head))
      return fail(res, 405, "Pull Request is not mergeable");
    const head = current(r, p.head)!;
    const c = makeCommit(
      r,
      p.base,
      `Merge pull request #${p.number}`,
      (files) => {
        files.clear();
        for (const [k, v] of head.files) files.set(k, v);
      },
    );
    p.state = "closed";
    p.merged = true;
    p.merge = c.sha;
    return reply(res, 200, {
      sha: c.sha,
      merged: true,
      message: "Pull Request successfully merged",
    });
  }
  return method === "GET"
    ? reply(res, 200, pullView(r, p))
    : fail(res, 404, "Not Found");
}
async function rest(
  req: IncomingMessage,
  res: ServerResponse,
  u: URL,
): Promise<void> {
  if (!auth(req)) return fail(res, 401, "Bad credentials");
  const m = req.method ?? "GET",
    p = u.pathname
      .replace(/^\/api\/v3\/?/, "")
      .split("/")
      .filter(Boolean);
  if (!p.length && m === "GET")
    return reply(
      res,
      200,
      { current_user_url: "/api/v3/user" },
      { "x-oauth-scopes": "repo, read:org" },
    );
  if (p[0] === "meta" && m === "GET")
    return reply(res, 200, { installed_version: "forge/1.0" });
  if (p[0] === "user" && p[1] === "repos") {
    if (m === "POST") {
      const b = await body(req);
      if (!b || !string(b.name)) return fail(res, 400, "Invalid JSON");
      if (repos.has(repoKey(string(b.name))))
        return fail(res, 422, "Repository already exists");
      return reply(
        res,
        201,
        repoView(
          createRepo(string(b.name), string(b.description), b.private === true),
        ),
      );
    }
    if (m === "GET") {
      const page = Number(u.searchParams.get("page") ?? 1),
        per = Number(u.searchParams.get("per_page") ?? 30),
        all = [...repos.values()],
        start = (page - 1) * per;
      const h =
        start + per < all.length
          ? {
              link: `</api/v3/user/repos?page=${page + 1}&per_page=${per}>; rel="next"`,
            }
          : {};
      return reply(res, 200, all.slice(start, start + per).map(repoView), h);
    }
  }
  if (p[0] === "user" && p.length === 1 && m === "GET")
    return reply(res, 200, { login: OWNER, id: 1000 });
  if (p[0] !== "repos" || p.length < 3) return fail(res, 404, "Not Found");
  if (decodeURIComponent(p[1]) !== OWNER) return fail(res, 404, "Not Found");
  const r = repos.get(repoKey(decodeURIComponent(p[2])));
  if (!r) return fail(res, 404, "Not Found");
  const t = p.slice(3);
  if (!t.length) {
    if (m === "GET") return reply(res, 200, repoView(r));
    if (m === "DELETE") {
      repos.delete(repoKey(r.name));
      return reply(res, 204);
    }
    if (m === "PATCH") {
      const b = await body(req);
      if (!b) return fail(res, 400, "Invalid JSON");
      if (typeof b.description === "string") r.description = b.description;
      return reply(res, 200, repoView(r));
    }
  }
  if (t[0] === "git" && t[1] === "refs" && m === "POST") {
    const b = await body(req),
      ref = string(b?.ref).replace(/^refs\/heads\//, ""),
      object = b?.object as Record<string, unknown> | undefined,
      commitSha = string(object?.sha);
    if (!ref || !r.commits.has(commitSha))
      return fail(res, 422, "Reference does not exist");
    r.branch.set(ref, commitSha);
    return reply(res, 201, {
      ref: `refs/heads/${ref}`,
      object: { sha: commitSha, type: "commit" },
    });
  }
  if (t[0] === "branches" && m === "GET")
    return reply(
      res,
      200,
      [...r.branch].map(([name, commit]) => ({
        name,
        commit: { sha: commit },
      })),
    );
  if (t[0] === "commits" && m === "GET") {
    let c = current(r, u.searchParams.get("sha") ?? "main"),
      out: unknown[] = [];
    while (c) {
      out.push({
        sha: c.sha,
        commit: { message: c.message },
        parents: c.parent ? [{ sha: c.parent }] : [],
      });
      c = c.parent ? r.commits.get(c.parent) : undefined;
    }
    return reply(res, 200, out);
  }
  if (t[0] === "contents")
    return contents(
      req,
      res,
      r,
      t.slice(1).map(decodeURIComponent).join("/"),
      u,
    );
  if (t[0] === "labels" && m === "POST") {
    const b = await body(req);
    if (!b || !string(b.name)) return fail(res, 400, "Invalid JSON");
    const label: Label = {
      id: next++,
      name: string(b.name),
      color: string(b.color, "ededed"),
    };
    r.labels.set(label.name, label);
    return reply(res, 201, label);
  }
  if (t[0] === "issues") return issues(req, res, r, t.slice(1), u);
  if (t[0] === "pulls") return pulls(req, res, r, t.slice(1), u);
  return fail(res, 404, "Not Found");
}
async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!auth(req)) return fail(res, 401, "Bad credentials");
  const b = await body(req);
  if (!b)
    return reply(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  const id = b.id ?? null,
    method = string(b.method),
    result = (x: unknown) => reply(res, 200, { jsonrpc: "2.0", id, result: x }),
    tools = [
      "create_repo",
      "get_repo",
      "create_issue",
      "list_issues",
      "create_pull_request",
      "merge_pull_request",
    ].map((name) => ({
      name,
      description: `${name.replaceAll("_", " ")} in the forge.`,
      inputSchema: { type: "object" },
    }));
  if (method === "initialize" || method === "server/discover")
    return result({
      protocolVersion: "2026-07-28",
      supportedVersions: ["2026-07-28", "2025-11-25"],
      serverInfo: { name: "forge", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  if (method === "notifications/initialized") return reply(res, 202);
  if (method === "tools/list") return result({ tools });
  if (method !== "tools/call")
    return reply(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  const p = (b.params ?? {}) as Record<string, unknown>,
    a = (p.arguments ?? {}) as Record<string, unknown>,
    name = string(p.name).replace(/^.*__/, "");
  let value: unknown;
  if (name === "create_repo") value = repoView(createRepo(string(a.name)));
  else {
    const r = repos.get(repoKey(string(a.repo)));
    if (!r)
      value = { isError: true, content: [{ type: "text", text: "Not Found" }] };
    else if (name === "get_repo") value = repoView(r);
    else if (name === "list_issues") value = r.issues.map(issueView);
    else if (name === "create_issue") {
      const i: Issue = {
        id: next++,
        number: r.issueNo++,
        title: string(a.title),
        body: string(a.body),
        state: "open",
        labels: [],
        comments: [],
        order: next,
      };
      r.issues.push(i);
      value = issueView(i);
    } else if (name === "create_pull_request") {
      const q: Pull = {
        id: next++,
        number: r.pullNo++,
        title: string(a.title),
        body: "",
        state: "open",
        head: string(a.head),
        base: string(a.base, "main"),
        merged: false,
      };
      r.pulls.push(q);
      value = pullView(r, q);
    } else if (name === "merge_pull_request") {
      const q = r.pulls.find((x) => x.number === Number(a.pull_number));
      if (q) {
        q.state = "closed";
        q.merged = true;
        value = pullView(r, q);
      } else
        value = {
          isError: true,
          content: [{ type: "text", text: "Not Found" }],
        };
    } else
      return reply(res, 200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unknown tool" },
      });
  }
  return result({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  });
}
async function graphql(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!auth(req)) return fail(res, 401, "Bad credentials");
  const b = await body(req);
  if (!b || !string(b.query)) return fail(res, 400, "Invalid JSON");
  const q = string(b.query),
    v = (b.variables ?? {}) as Record<string, unknown>,
    errors = (message: string) =>
      reply(res, 200, { data: null, errors: [{ message }] });
  if (/\bunknown[A-Za-z]*\b/.test(q))
    return errors("Cannot query field on type Query.");
  if (q.includes("__type")) {
    const name = string(v.name);
    const fields: Record<string, string[]> = {
      Issue: ["id", "number", "title", "state", "body"],
      PullRequest: [
        "id",
        "number",
        "headRefName",
        "baseRefName",
        "mergeable",
        "state",
        "merged",
        "files",
      ],
      Repository: [
        "id",
        "databaseId",
        "name",
        "nameWithOwner",
        "owner",
        "defaultBranchRef",
        "viewerPermission",
        "hasIssuesEnabled",
        "issue",
        "issues",
        "pullRequests",
      ],
    };
    return reply(res, 200, {
      data: {
        __type:
          name === "SearchType"
            ? { enumValues: [{ name: "ISSUE" }] }
            : { name, fields: (fields[name] ?? []).map((name) => ({ name })) },
      },
    });
  }
  let owner = string(v.owner, OWNER),
    name = string(v.name);
  const match = q.match(
    /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"/,
  );
  if (match) {
    owner = match[1];
    name = match[2];
  }
  const r = owner === OWNER ? repos.get(repoKey(name)) : undefined;
  const repo = r
    ? {
        id: `R_${r.id}`,
        databaseId: r.id,
        name: r.name,
        nameWithOwner: repoKey(r.name),
        owner: { login: OWNER },
        defaultBranchRef: {
          name: "main",
          target: { oid: r.branch.get("main") ?? "" },
        },
        viewerPermission: "ADMIN",
        hasIssuesEnabled: true,
        issue: (args: { number: number }) =>
          issueView(
            r.issues.find((x) => x.number === args.number) ?? ({} as Issue),
          ),
        issues: { nodes: r.issues.map(issueView) },
        pullRequests: { nodes: r.pulls.map((p) => pullView(r, p)) },
      }
    : null;
  if (q.includes("createPullRequest")) {
    if (!r)
      return reply(res, 200, {
        data: { createPullRequest: null },
        errors: [{ message: "Repository not found" }],
      });
    const input = (v.input ?? {}) as Record<string, unknown>,
      head = string(input.headRefName),
      base = string(input.baseRefName, "main");
    if (!r.branch.has(head) || !r.branch.has(base))
      return errors("Invalid branch");
    const p: Pull = {
      id: next++,
      number: r.pullNo++,
      title: string(input.title),
      body: string(input.body),
      state: "open",
      head,
      base,
      merged: false,
    };
    r.pulls.push(p);
    return reply(res, 200, {
      data: { createPullRequest: { pullRequest: pullView(r, p) } },
    });
  }
  const data: Record<string, unknown> = {};
  if (q.includes("viewer")) data.viewer = { login: OWNER, id: "U_1000" };
  if (q.includes("repository")) data.repository = repo;
  return reply(res, 200, { data });
}
export function createApp(): Server {
  return createServer(
    (req, res) =>
      void (async () => {
        const u = url(req);
        if (req.method === "GET" && u.pathname === "/healthz")
          return reply(res, 200, { ok: true });
        if (u.pathname.startsWith("/api/v3")) return rest(req, res, u);
        if (req.method === "POST" && u.pathname === "/api/graphql")
          return graphql(req, res);
        if (req.method === "POST" && u.pathname === "/mcp")
          return mcp(req, res);
        return fail(res, 404, "Not Found");
      })().catch((e) =>
        fail(
          res,
          500,
          e instanceof Error ? e.message : "Internal Server Error",
        ),
      ),
  );
}
