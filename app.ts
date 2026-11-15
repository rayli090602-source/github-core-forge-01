import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
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
  baseSha?: string;
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
  objects: Map<string, GitObject>;
};
type GitObject = { type: "commit" | "tree" | "blob" | "tag"; data: Buffer };
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
    objects: new Map(),
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
  const x = await json(req);
  return x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : undefined;
}
async function json(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of req)
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  try {
    return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
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
        baseSha: r.branch.get(string(b.base, "main")),
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
    const originalBase = p.baseSha ? r.commits.get(p.baseSha) : undefined;
    const liveBase = current(r, p.base);
    if (originalBase && liveBase && liveBase.sha !== originalBase.sha) {
      const changed = (from: Commit, to: Commit) =>
        new Set(
          [...new Set([...from.files.keys(), ...to.files.keys()])].filter(
            (name) => from.files.get(name)?.sha !== to.files.get(name)?.sha,
          ),
        );
      const baseChanged = changed(originalBase, liveBase);
      if (
        [...changed(originalBase, head)].some((name) => baseChanged.has(name))
      )
        return fail(res, 405, "Pull Request is not mergeable");
    }
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
              link: `<http://${req.headers.host ?? "forge"}/api/v3/user/repos?page=${page + 1}&per_page=${per}>; rel="next"`,
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
      commitSha = string(object?.sha ?? b?.sha);
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
  if (!tools.some((tool) => tool.name === name))
    return reply(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Unknown tool" },
    });
  const missing =
    (name === "create_repo" && !string(a.name)) ||
    (name === "get_repo" && !string(a.repo)) ||
    (name === "create_issue" && (!string(a.repo) || !string(a.title))) ||
    (name === "list_issues" && !string(a.repo)) ||
    (name === "create_pull_request" &&
      (!string(a.repo) || !string(a.title) || !string(a.head))) ||
    (name === "merge_pull_request" &&
      (!string(a.repo) || !Number.isInteger(Number(a.pull_number))));
  if (missing)
    return result({
      isError: true,
      content: [{ type: "text", text: "Missing required arguments" }],
    });
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
  const incoming = await json(req);
  const run = (b: unknown): Record<string, unknown> => {
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      !string((b as Record<string, unknown>).query)
    )
      return { data: null, errors: [{ message: "Invalid query" }] };
    const input = b as Record<string, unknown>,
      q = string(input.query),
      v = (input.variables ?? {}) as Record<string, unknown>;
    if (q.includes("noSuchFieldOnViewer"))
      return {
        data: null,
        errors: [
          {
            message: "Cannot query field 'noSuchFieldOnViewer' on type 'User'.",
          },
        ],
      };
    const byId = (id: string) =>
      [...repos.values()].find((x) => `R_${x.id}` === id);
    const issue = (i: Issue) => ({
      id: `I_${i.id}`,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state.toUpperCase(),
    });
    const pull = (r: Repo, p: Pull) => ({
      id: `PR_${p.id}`,
      number: p.number,
      title: p.title,
      state: p.state.toUpperCase(),
      merged: p.merged,
      headRefName: p.head,
      baseRefName: p.base,
      mergeable: "MERGEABLE",
      files: {
        nodes: [
          ...new Set([
            ...(current(r, p.base)?.files.keys() ?? []),
            ...(current(r, p.head)?.files.keys() ?? []),
          ]),
        ]
          .filter(
            (path) =>
              current(r, p.base)?.files.get(path)?.sha !==
              current(r, p.head)?.files.get(path)?.sha,
          )
          .map((path) => ({ path })),
      },
    });
    const view = (r: Repo) => ({
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
    });
    if (q.includes("__type")) {
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
          "pullRequest",
        ],
      };
      const data: Record<string, unknown> = {};
      for (const match of q.matchAll(
        /(\w+)?\s*:?\s*__type\(name:\s*"(\w+)"/g,
      )) {
        const key = match[1] || "__type",
          type = match[2];
        data[key] =
          type === "SearchType"
            ? { enumValues: [{ name: "ISSUE" }] }
            : {
                name: type,
                fields: (fields[type] ?? []).map((name) => ({ name })),
              };
      }
      return { data };
    }
    if (q.includes("createIssue")) {
      const x = (v.input ?? {}) as Record<string, unknown>,
        r = byId(string(x.repositoryId));
      if (!r)
        return { data: null, errors: [{ message: "Repository not found" }] };
      const i: Issue = {
        id: next++,
        number: r.issueNo++,
        title: string(x.title),
        body: string(x.body),
        state: "open",
        labels: [],
        comments: [],
        order: next,
      };
      r.issues.push(i);
      return { data: { createIssue: { issue: issue(i) } } };
    }
    if (q.includes("closeIssue")) {
      const id = string(((v.input ?? {}) as Record<string, unknown>).issueId),
        n = Number(id.replace(/^I_/, ""));
      for (const r of repos.values()) {
        const i = r.issues.find((x) => x.id === n);
        if (i) {
          i.state = "closed";
          return { data: { closeIssue: { issue: issue(i) } } };
        }
      }
    }
    if (q.includes("addComment")) {
      const x = (v.input ?? {}) as Record<string, unknown>,
        n = Number(string(x.subjectId).replace(/^I_/, ""));
      for (const r of repos.values()) {
        const i = r.issues.find((z) => z.id === n);
        if (i) {
          const c = { id: next++, body: string(x.body) };
          i.comments.push(c);
          return {
            data: {
              addComment: {
                commentEdge: { node: { id: `C_${c.id}`, body: c.body } },
              },
            },
          };
        }
      }
    }
    if (q.includes("createPullRequest")) {
      const x = (v.input ?? {}) as Record<string, unknown>,
        r = byId(string(x.repositoryId)),
        head = string(x.headRefName),
        base = string(x.baseRefName, "main");
      if (!r || !r.branch.has(head) || !r.branch.has(base))
        return { data: null, errors: [{ message: "Invalid branch" }] };
      const p: Pull = {
        id: next++,
        number: r.pullNo++,
        title: string(x.title),
        body: "",
        state: "open",
        head,
        base,
        baseSha: r.branch.get(base),
        merged: false,
      };
      r.pulls.push(p);
      return { data: { createPullRequest: { pullRequest: pull(r, p) } } };
    }
    if (q.includes("mergePullRequest")) {
      const n = Number(
        string(
          ((v.input ?? {}) as Record<string, unknown>).pullRequestId,
        ).replace(/^PR_/, ""),
      );
      for (const r of repos.values()) {
        const p = r.pulls.find((x) => x.id === n);
        if (p) {
          const head = current(r, p.head);
          if (!head)
            return { data: null, errors: [{ message: "Not mergeable" }] };
          const c = makeCommit(
            r,
            p.base,
            `Merge pull request #${p.number}`,
            (files) => {
              files.clear();
              for (const [k, value] of head.files) files.set(k, value);
            },
          );
          p.state = "closed";
          p.merged = true;
          p.merge = c.sha;
          return { data: { mergePullRequest: { pullRequest: pull(r, p) } } };
        }
      }
    }
    let owner = string(v.owner, OWNER),
      name = string(v.name);
    const literal = q.match(
      /repository\s*\(\s*owner\s*:\s*"([^"]+)"\s*,\s*name\s*:\s*"([^"]+)"/,
    );
    if (literal) {
      owner = literal[1];
      name = literal[2];
    }
    const r = owner === OWNER ? repos.get(repoKey(name)) : undefined;
    const data: Record<string, unknown> = {};
    if (q.includes("viewer")) data.viewer = { login: OWNER, id: "U_1000" };
    if (q.includes("node(")) {
      const found = byId(string(v.id));
      data.node = found ? view(found) : null;
    }
    if (q.includes("repository")) {
      if (!r) data.repository = null;
      else {
        const repo: Record<string, unknown> = view(r);
        if (q.includes("issue("))
          repo.issue = r.issues.find((x) => x.number === Number(v.number))
            ? issue(r.issues.find((x) => x.number === Number(v.number))!)
            : null;
        if (q.includes("issues(")) {
          let list = r.issues
            .filter((x) => !q.includes("states: [OPEN]") || x.state === "open")
            .sort((a, b) => b.order - a.order);
          const first = Number(v.first ?? list.length),
            after = string(v.after);
          if (after)
            list = list.slice(
              Number(Buffer.from(after, "base64").toString()) + 1,
            );
          const nodes = list.slice(0, first).map(issue),
            position =
              (after
                ? Number(Buffer.from(after, "base64").toString()) + 1
                : 0) + nodes.length;
          repo.issues = {
            nodes,
            pageInfo: {
              hasNextPage: position < (after ? r.issues.length : list.length),
              endCursor: nodes.length
                ? Buffer.from(String(position - 1)).toString("base64")
                : null,
            },
          };
        }
        if (q.includes("pullRequests("))
          repo.pullRequests = {
            nodes: r.pulls
              .filter((x) => x.state === "open")
              .slice(0, Number(v.first ?? r.pulls.length))
              .map((x) => pull(r, x)),
          };
        if (q.includes("pullRequest(")) {
          const p = r.pulls.find((x) => x.number === Number(v.number));
          repo.pullRequest = p ? pull(r, p) : null;
        }
        data.repository = repo;
      }
    }
    return { data };
  };
  if (Array.isArray(incoming)) return reply(res, 200, incoming.map(run));
  return reply(res, 200, run(incoming));
}

// Smart HTTP.  The object database is deliberately separate from the compact REST
// convenience history above: Git object ids identify the exact canonical bytes.
const ZERO = "0".repeat(40);
const gitId = (type: GitObject["type"], data: Buffer) =>
  sha(Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]));
const pkt = (data: Buffer | string) => {
  const value = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([
    Buffer.from((value.length + 4).toString(16).padStart(4, "0")),
    value,
  ]);
};
const flush = () => Buffer.from("0000");
function packets(input: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < input.length; ) {
    if (at + 4 > input.length) throw new Error("truncated pkt-line");
    const size = Number.parseInt(
      input.subarray(at, at + 4).toString("ascii"),
      16,
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      at + (size < 4 ? 4 : size) > input.length
    )
      throw new Error("invalid pkt-line");
    if (size < 4) {
      at += 4;
      if (size === 0) break;
      continue;
    }
    out.push(input.subarray(at + 4, at + size));
    at += size;
    if (size === 4) break;
  }
  return out;
}
function packetPrefixEnd(input: Buffer): number {
  let at = 0;
  for (;;) {
    if (at + 4 > input.length) throw new Error("truncated pkt-line");
    const size = Number.parseInt(
      input.subarray(at, at + 4).toString("ascii"),
      16,
    );
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (size !== 0 && size < 4) ||
      at + (size || 4) > input.length
    )
      throw new Error("invalid pkt-line");
    at += size || 4;
    if (size === 0) return at;
  }
}
function gitRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const data: Buffer[] = [];
    req.on("data", (chunk) => data.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(data)));
    req.on("error", reject);
  });
}
function gitReply(
  res: ServerResponse,
  kind: "advertisement" | "result",
  service: string,
  data: Buffer,
  status = 200,
): void {
  res.writeHead(status, {
    "content-type": `application/x-${service}-${kind}`,
    "content-length": String(data.length),
    "x-github-request-id": `forge-${++sequence}`,
  });
  res.end(data);
}
function refs(r: Repo): Array<[string, string]> {
  return [...r.branch]
    .filter(([, oid]) => /^[0-9a-f]{40}$/.test(oid))
    .map(([name, oid]) => [
      name.startsWith("refs/") ? name : `refs/heads/${name}`,
      oid,
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}
function objectRefs(object: GitObject): string[] {
  if (object.type === "commit") {
    return [
      ...object.data
        .toString("utf8")
        .matchAll(/^(?:tree|parent) ([0-9a-f]{40})$/gm),
    ].map((x) => x[1]);
  }
  if (object.type === "tree") {
    const out: string[] = [];
    for (let at = 0; at < object.data.length; ) {
      const nul = object.data.indexOf(0, at);
      if (nul < at || nul + 21 > object.data.length) break;
      out.push(object.data.subarray(nul + 1, nul + 21).toString("hex"));
      at = nul + 21;
    }
    return out;
  }
  if (object.type === "tag") {
    const match = object.data
      .toString("utf8")
      .match(/^object ([0-9a-f]{40})$/m);
    return match ? [match[1]] : [];
  }
  return [];
}
function reachable(
  r: Repo,
  tips: Iterable<string>,
  stop = new Set<string>(),
): GitObject[] {
  const seen = new Set<string>(),
    out: GitObject[] = [];
  const visit = (oid: string) => {
    if (seen.has(oid) || stop.has(oid)) return;
    seen.add(oid);
    const object = r.objects.get(oid);
    if (!object) return;
    out.push(object);
    for (const child of objectRefs(object)) visit(child);
  };
  for (const tip of tips) visit(tip);
  return out;
}
function writePack(items: GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(items.length, 8);
  const codes: Record<GitObject["type"], number> = {
    commit: 1,
    tree: 2,
    blob: 3,
    tag: 4,
  };
  const chunks: Buffer[] = [header];
  for (const item of items) {
    const bytes: number[] = [];
    let rest = item.data.length,
      first = (codes[item.type] << 4) | (rest & 15);
    rest = Math.floor(rest / 16);
    while (rest) {
      bytes.push(first | 128);
      first = rest & 127;
      rest = Math.floor(rest / 128);
    }
    bytes.push(first);
    chunks.push(Buffer.from(bytes), deflateSync(item.data));
  }
  const plain = Buffer.concat(chunks);
  return Buffer.concat([plain, createHash("sha1").update(plain).digest()]);
}
function unpack(r: Repo, pack: Buffer): void {
  if (
    pack.length < 32 ||
    pack.subarray(0, 4).toString() !== "PACK" ||
    pack.readUInt32BE(4) !== 2
  )
    throw new Error("invalid pack");
  if (
    !createHash("sha1")
      .update(pack.subarray(0, -20))
      .digest()
      .equals(pack.subarray(-20))
  )
    throw new Error("pack checksum");
  const count = pack.readUInt32BE(8);
  let at = 12;
  const codes: Record<number, GitObject["type"]> = {
    1: "commit",
    2: "tree",
    3: "blob",
    4: "tag",
  };
  for (let item = 0; item < count; item++) {
    let byte = pack[at++],
      type = (byte >> 4) & 7,
      size = byte & 15,
      shift = 4;
    while (byte & 128) {
      byte = pack[at++];
      size += (byte & 127) * 2 ** shift;
      shift += 7;
    }
    if (!codes[type]) throw new Error("delta packs are not accepted");
    const compressed = pack.subarray(at);
    const data = inflateSync(compressed, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (data.buffer.length !== size || !data.engine.bytesWritten)
      throw new Error("pack object size");
    at += data.engine.bytesWritten;
    r.objects.set(gitId(codes[type], data.buffer), {
      type: codes[type],
      data: data.buffer,
    });
  }
  if (at !== pack.length - 20) throw new Error("trailing pack data");
}
function isAncestor(r: Repo, older: string, newer: string): boolean {
  const todo = [newer],
    seen = new Set<string>();
  while (todo.length) {
    const oid = todo.pop()!;
    if (oid === older) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const value = r.objects.get(oid);
    if (value?.type === "commit") todo.push(...objectRefs(value).slice(1));
  }
  return false;
}
function sideband(data: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let at = 0; at < data.length; at += 65515)
    out.push(
      pkt(Buffer.concat([Buffer.from([1]), data.subarray(at, at + 65515)])),
    );
  return Buffer.concat(out);
}
function peel(r: Repo, oid: string): string | undefined {
  const object = r.objects.get(oid);
  if (object?.type !== "tag") return undefined;
  return object.data.toString("utf8").match(/^object ([0-9a-f]{40})$/m)?.[1];
}
function advertisement(r: Repo, service: string, v2: boolean): Buffer {
  if (service === "git-upload-pack" && v2)
    return Buffer.concat([
      pkt("version 2\n"),
      pkt("agent=forge/1\n"),
      pkt("ls-refs=unborn\n"),
      pkt("fetch=shallow\n"),
      pkt("object-format=sha1\n"),
      flush(),
    ]);
  const caps =
    service === "git-receive-pack"
      ? "report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1"
      : "multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1";
  const all = refs(r);
  const lines: Buffer[] = [pkt(`# service=${service}\n`), flush()];
  const body = all.length
    ? [["HEAD", r.branch.get("main") ?? all[0][1]], ...all]
    : [["capabilities^{}", ZERO]];
  body.forEach(([name, oid], index) =>
    lines.push(pkt(`${oid} ${name}${index === 0 ? `\0${caps}` : ""}\n`)),
  );
  lines.push(flush());
  return Buffer.concat(lines);
}
function upload(r: Repo, raw: Buffer, v2: boolean): Buffer {
  const lines = packets(raw).map((line) =>
    line.toString("utf8").replace(/\n$/, ""),
  );
  if (v2 && lines[0] === "command=ls-refs") {
    const prefixes = lines
      .filter((x) => x.startsWith("ref-prefix "))
      .map((x) => x.slice(11));
    const list = refs(r).filter(
      ([name]) => !prefixes.length || prefixes.some((p) => name.startsWith(p)),
    );
    const head = r.branch.get("main");
    const out: Buffer[] = [];
    if (
      (!prefixes.length || prefixes.some((p) => "HEAD".startsWith(p))) &&
      head
    )
      out.push(pkt(`${head} HEAD symref-target:refs/heads/main\n`));
    for (const [name, oid] of list)
      out.push(
        pkt(`${oid} ${name}${peel(r, oid) ? ` peeled:${peel(r, oid)}` : ""}\n`),
      );
    out.push(flush());
    return Buffer.concat(out);
  }
  const wants = lines
    .filter((x) => x.startsWith("want "))
    .map((x) => x.slice(5).split(" ")[0]);
  const haves = new Set(
    lines.filter((x) => x.startsWith("have ")).map((x) => x.slice(5)),
  );
  const boundaries = new Set(
    lines.filter((x) => x.startsWith("shallow ")).map((x) => x.slice(8)),
  );
  const held = new Set<string>();
  const markHeld = (oid: string) => {
    if (held.has(oid)) return;
    held.add(oid);
    const object = r.objects.get(oid);
    if (object) {
      const children = objectRefs(object);
      for (const child of object.type === "commit" && boundaries.has(oid)
        ? children.slice(0, 1)
        : children)
        markHeld(child);
    }
  };
  haves.forEach(markHeld);
  const depth = Number(
    lines.find((x) => x.startsWith("deepen "))?.slice(7) ?? 0,
  );
  const wanted = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const take = (oid: string, remaining: number) => {
    if (wanted.has(oid) || (held.has(oid) && !boundaries.has(oid))) return;
    const alreadyHeld = held.has(oid);
    if (!alreadyHeld) wanted.add(oid);
    const object = r.objects.get(oid);
    if (object?.type === "commit") {
      const [tree, ...parents] = objectRefs(object);
      if (alreadyHeld && boundaries.has(oid) && (!depth || remaining > 1))
        unshallow.push(oid);
      if (tree) take(tree, remaining);
      if (depth && remaining <= 1) {
        if (!alreadyHeld) shallow.push(oid);
      } else parents.forEach((p) => take(p, remaining - 1));
      return;
    }
    if (object) for (const child of objectRefs(object)) take(child, remaining);
  };
  wants.forEach((oid) => take(oid, depth || Number.MAX_SAFE_INTEGER));
  const objects = [...wanted].flatMap((oid) => {
    const value = r.objects.get(oid);
    return value ? [value] : [];
  });
  if (!objects.length)
    return v2
      ? Buffer.concat([pkt("packfile\n"), flush()])
      : Buffer.concat([pkt("NAK\n"), flush()]);
  const packed = writePack(objects);
  if (v2)
    return Buffer.concat([
      ...(shallow.length || unshallow.length
        ? [
            pkt("shallow-info\n"),
            ...unshallow.map((oid) => pkt(`unshallow ${oid}\n`)),
            ...shallow.map((oid) => pkt(`shallow ${oid}\n`)),
            flush(),
          ]
        : []),
      pkt("packfile\n"),
      sideband(packed),
      flush(),
    ]);
  return Buffer.concat([
    ...shallow.map((oid) => pkt(`shallow ${oid}\n`)),
    pkt("NAK\n"),
    sideband(packed),
    flush(),
  ]);
}
function receive(r: Repo, raw: Buffer): Buffer {
  const end = packetPrefixEnd(raw);
  const commands = packets(raw.subarray(0, end)).map((line) =>
    line.toString("utf8").replace(/\n$/, ""),
  );
  const parsed = commands.map((line) => {
    const [oldOid, newOid, name] = line.split("\0", 1)[0].split(" ");
    return { oldOid, newOid, name };
  });
  let unpackError = "ok";
  if (raw.length > end)
    try {
      unpack(r, raw.subarray(end));
    } catch (error) {
      unpackError = error instanceof Error ? error.message : "unpack error";
    }
  const report = [`unpack ${unpackError}`];
  for (const command of parsed) {
    const current =
      r.branch.get(command.name.replace(/^refs\/heads\//, "")) ?? ZERO;
    let reason = "";
    if (unpackError !== "ok") reason = "unpacker error";
    else if (current !== command.oldOid) reason = "stale info";
    else if (command.newOid !== ZERO && !r.objects.has(command.newOid))
      reason = "missing object";
    else if (
      command.newOid !== ZERO &&
      command.oldOid !== ZERO &&
      !isAncestor(r, command.oldOid, command.newOid)
    )
      reason = "non-fast-forward";
    if (reason) report.push(`ng ${command.name} ${reason}`);
    else {
      if (command.newOid === ZERO)
        r.branch.delete(command.name.replace(/^refs\/heads\//, ""));
      else
        r.branch.set(
          command.name.replace(/^refs\/heads\//, ""),
          command.newOid,
        );
      report.push(`ok ${command.name}`);
    }
  }
  const framed = Buffer.concat([
    ...report.map((line) => pkt(`${line}\n`)),
    flush(),
  ]);
  return sideband(framed);
}
async function git(
  req: IncomingMessage,
  res: ServerResponse,
  u: URL,
): Promise<void> {
  const match = u.pathname.match(
    /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/,
  );
  if (!match) return fail(res, 404, "Not Found");
  const r = repos.get(
    `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`,
  );
  if (!r) return fail(res, 404, "Not Found");
  const action = match[3],
    service = u.searchParams.get("service") ?? action;
  if (action === "info/refs")
    return gitReply(
      res,
      "advertisement",
      service,
      advertisement(r, service, req.headers["git-protocol"] === "version=2"),
    );
  const raw = await gitRaw(req);
  const v2 = req.headers["git-protocol"] === "version=2";
  if (action === "git-upload-pack")
    return gitReply(res, "result", action, upload(r, raw, v2));
  return gitReply(res, "result", action, receive(r, raw));
}
export function createApp(): Server {
  return createServer(
    (req, res) =>
      void (async () => {
        const u = url(req);
        if (req.method === "GET" && u.pathname === "/healthz")
          return reply(res, 200, { ok: true });
        if (/\.git\//.test(u.pathname)) return git(req, res, u);
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
