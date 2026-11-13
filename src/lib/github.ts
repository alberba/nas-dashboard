import type {
  DeployRelease,
  HostRole,
  RenovateCi,
  RenovateContainer,
  RenovatePullRequest,
  RenovateUpdate,
  RenovateUpdateType,
} from "./types";

const DEFAULT_REPOSITORY = "alberba/media-stack";
const DEFAULT_API_URL = "https://api.github.com";
const CHECK_TIMEOUT_MS = 15_000;

export class GithubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubConfigError";
  }
}

export class GithubUnavailable extends Error {
  constructor(readonly status: number) {
    super("GitHub no está disponible");
    this.name = "GithubUnavailable";
  }
}

export type GithubConfig = {
  token: string;
  repository: string;
  apiUrl: string;
};

/**
 * Reads the fine-grained token from the hub environment. Without a token the
 * Renovate section is disabled; the token never leaves the server.
 */
export function githubConfig(
  env: Record<string, string | undefined> = process.env,
): GithubConfig | null {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) return null;
  const repository = env.GITHUB_REPOSITORY?.trim() || DEFAULT_REPOSITORY;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
    throw new GithubConfigError("GITHUB_REPOSITORY debe tener el formato owner/repo");
  const raw = env.GITHUB_API_URL?.trim() || DEFAULT_API_URL;
  let apiUrl: string;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("protocolo");
    apiUrl = url.toString().replace(/\/+$/, "");
  } catch {
    throw new GithubConfigError("GITHUB_API_URL no es una URL válida");
  }
  return { token, repository, apiUrl };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Low-level authenticated GitHub request. It sets the token header on the
 * server only and never exposes the response object to callers that could
 * serialize it. A network failure or timeout is an unavailable GitHub, not a
 * definite outcome: merge mutations handle that distinction themselves.
 */
export async function githubFetch(
  config: GithubConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetch(`${config.apiUrl}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "User-Agent": "nas-dashboard",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    throw new GithubUnavailable(0);
  }
}

async function githubJson<T>(
  config: GithubConfig,
  path: string,
): Promise<T> {
  const response = await githubFetch(config, path);
  if (!response.ok) throw new GithubUnavailable(response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new GithubUnavailable(response.status);
  }
}

function isRenovateAuthor(login: string) {
  const author = login.toLowerCase();
  return (
    author === "renovate[bot]" ||
    author === "app/renovate" ||
    author === "renovate-bot"
  );
}

function isComposeFile(filename: string) {
  return /(^|\/)(?:docker-)?compose(?:\.[A-Za-z0-9_.-]+)?\.ya?ml$/.test(filename);
}

type ImageReference = {
  repository: string;
  tag: string | null;
  digest: string | null;
};

/** Splits an image reference without guessing versions from its string. */
export function imageReference(value: string): ImageReference {
  const at = value.indexOf("@");
  const digest = at >= 0 ? value.slice(at + 1) : null;
  const base = at >= 0 ? value.slice(0, at) : value;
  const slash = base.lastIndexOf("/");
  const colon = base.lastIndexOf(":");
  const tagged = colon > slash;
  return {
    repository: tagged ? base.slice(0, colon) : base,
    tag: tagged ? base.slice(colon + 1) : null,
    digest,
  };
}

function displayedReference(reference: ImageReference) {
  return reference.tag ?? reference.digest ?? "latest";
}

function versionParts(tag: string): number[] | null {
  const parts = tag.match(/\d+/g);
  if (!parts?.length) return null;
  return parts.map(Number);
}

/** Fallback for bodies without a Renovate table: compare the leading numbers. */
export function classifyTags(from: string, to: string): RenovateUpdateType {
  if (!from || !to || from === to) return "unknown";
  if (from.startsWith("sha256:") || to.startsWith("sha256:")) return "digest";
  const before = versionParts(from);
  const after = versionParts(to);
  if (!before || !after) return "unknown";
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    if ((before[index] ?? 0) === (after[index] ?? 0)) continue;
    if (index === 0) return "major";
    if (index === 1) return "minor";
    return "patch";
  }
  return "patch";
}

function updateType(value: string): RenovateUpdateType | null {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "major") return "major";
  if (normalized === "minor") return "minor";
  if (normalized === "patch") return "patch";
  if (normalized === "digest" || normalized === "pindigest") return "digest";
  if (normalized === "pin") return "pin";
  return null;
}

/**
 * Renovate writes the update type in a stable Markdown table. It is the
 * authoritative source (a linuxserver revision and a digest both look unlike
 * a semver change), so it wins over classifying tags.
 */
export function renovateTypes(body: string): Map<string, RenovateUpdateType> {
  const types = new Map<string, RenovateUpdateType>();
  for (const line of body.split("\n")) {
    const cells = line.split("|");
    if (cells.length < 5) continue;
    const packageCell = cells[1].trim();
    const updateCell = cells[2].trim();
    const type = updateType(updateCell);
    if (!type) continue;
    const linked = packageCell.match(/^\[([^\]]+)\]\(/);
    const packageName = (linked?.[1] ?? packageCell).replace(/`/g, "").trim();
    if (packageName) types.set(packageName, type);
  }
  return types;
}

function typeForImage(
  types: Map<string, RenovateUpdateType>,
  image: string,
  from: string,
  to: string,
): RenovateUpdateType {
  return (
    types.get(image) ??
    types.get(image.replace(/^docker\.io\//, "")) ??
    types.get(`docker.io/${image}`) ??
    classifyTags(from, to)
  );
}

type ParsedImageChange = {
  service: string;
  image: string;
  from: string;
  to: string;
};

function pairImages(patch: string): ParsedImageChange[] {
  const removed = new Map<string, string[]>();
  const added = new Map<string, string[]>();
  let service: string | null = null;
  let serviceIndent = 2;
  let afterServices = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      service = null;
      afterServices = false;
      continue;
    }
    if (!raw || raw.startsWith("\\")) continue;
    const marker = raw[0];
    if (![" ", "+", "-"].includes(marker)) continue;
    const content = raw.slice(1);
    if (!content.trim()) continue;
    const indent = content.length - content.trimStart().length;
    const value = content.trim();
    if (value === "services:") {
      afterServices = true;
      service = null;
      continue;
    }
    const key = value.match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (key) {
      if (afterServices) {
        serviceIndent = indent;
        afterServices = false;
        service = key[1];
        continue;
      }
      if (indent === serviceIndent) {
        service = key[1];
        continue;
      }
    }
    const image = value.match(/^image:\s*(\S+)\s*(?:#.*)?$/);
    if (!image || !service || indent <= serviceIndent) continue;
    const target = marker === "-" ? removed : marker === "+" ? added : null;
    if (!target) continue;
    const entries = target.get(service) ?? [];
    entries.push(image[1]);
    target.set(service, entries);
  }
  const changes: ParsedImageChange[] = [];
  for (const [name, before] of removed) {
    const after = added.get(name) ?? [];
    const count = Math.min(before.length, after.length);
    for (let index = 0; index < count; index += 1) {
      const oldReference = imageReference(before[index]);
      const newReference = imageReference(after[index]);
      if (before[index] === after[index]) continue;
      let from = displayedReference(oldReference);
      let to = displayedReference(newReference);
      if (
        oldReference.digest &&
        newReference.digest &&
        oldReference.tag === newReference.tag
      ) {
        from = oldReference.digest;
        to = newReference.digest;
      }
      changes.push({
        service: name,
        image: oldReference.repository || newReference.repository,
        from,
        to,
      });
    }
  }
  return changes;
}

function automergeEnabled(body: string) {
  const match = body.match(/Automerge\*{0,2}\s*:\s*([^\n]+)/i);
  return Boolean(match && /^\s*enabled/i.test(match[1]));
}

function highestType(updates: RenovateUpdate[]): RenovateUpdateType {
  const order: RenovateUpdateType[] = [
    "major",
    "minor",
    "patch",
    "digest",
    "pin",
    "unknown",
  ];
  for (const type of order) {
    if (updates.some((update) => update.type === type)) return type;
  }
  return "unknown";
}

function requiresWorker(updates: RenovateUpdate[]) {
  return updates.some(
    (update) =>
      update.file.startsWith("worker/") ||
      update.image.endsWith("/tdarr_node") ||
      update.service === "tdarr-node",
  );
}

/** Compose projects whose name is declared by the file itself. */
function projectForFile(file: string) {
  if (file.startsWith("worker/")) return "media-stack-worker";
  if (file.startsWith("apps-server/")) return "media-stack-apps";
  return null;
}

type RawCheckRun = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
};

function ciFromChecks(runs: RawCheckRun[]): RenovateCi {
  if (!runs.length) return "none";
  // A re-run creates another check run with the same name: keep the newest one.
  const latest = new Map<string, RawCheckRun>();
  for (const run of runs) {
    const name = text(run.name) ?? "";
    const id = typeof run.id === "number" ? run.id : 0;
    const current = latest.get(name);
    const currentId = typeof current?.id === "number" ? current.id : -1;
    if (!current || id >= currentId) latest.set(name, run);
  }
  const selected = [...latest.values()];
  if (selected.some((run) => run.status !== "completed")) return "pending";
  if (
    selected.some((run) =>
      ["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(
        text(run.conclusion) ?? "",
      ),
    )
  )
    return "failure";
  if (
    selected.every((run) =>
      ["success", "neutral", "skipped"].includes(text(run.conclusion) ?? ""),
    )
  )
    return "success";
  return "none";
}

async function pullRequestCi(config: GithubConfig, sha: string) {
  const data = await githubJson<{ check_runs?: RawCheckRun[] }>(
    config,
    `/repos/${config.repository}/commits/${sha}/check-runs?per_page=100`,
  );
  return ciFromChecks(Array.isArray(data.check_runs) ? data.check_runs : []);
}

type Candidate = {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  headSha: string;
  draft: boolean;
  body: string;
};

function candidate(value: unknown, requireOpen = true): Candidate | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const number = typeof raw.number === "number" ? raw.number : null;
  const user = asRecord(raw.user);
  const head = asRecord(raw.head);
  const login = text(user?.login);
  const branch = text(head?.ref);
  if (!number || !login || !branch) return null;
  if (!isRenovateAuthor(login) || !branch.startsWith("renovate/")) return null;
  if (requireOpen && text(raw.state) && text(raw.state) !== "open") return null;
  return {
    number,
    title: text(raw.title) ?? `#${number}`,
    url: text(raw.html_url) ?? `https://github.com/${DEFAULT_REPOSITORY}/pull/${number}`,
    branch,
    author: login,
    headSha: text(head?.sha) ?? "",
    draft: raw.draft === true,
    body: text(raw.body) ?? "",
  };
}

type RawFile = {
  filename?: unknown;
  patch?: unknown;
};

function updatesFromFiles(files: RawFile[], body: string) {
  const types = renovateTypes(body);
  const updates: RenovateUpdate[] = [];
  for (const file of files) {
    const filename = text(file.filename);
    const patch = text(file.patch);
    if (!filename || !patch || !isComposeFile(filename)) continue;
    for (const change of pairImages(patch)) {
      updates.push({
        file: filename,
        service: change.service,
        image: change.image,
        from: change.from,
        to: change.to,
        type: typeForImage(types, change.image, change.from, change.to),
      });
    }
  }
  return updates;
}

async function pullRequest(
  config: GithubConfig,
  value: Candidate,
): Promise<RenovatePullRequest | null> {
  const [files, ci] = await Promise.all([
    githubJson<RawFile[]>(
      config,
      `/repos/${config.repository}/pulls/${value.number}/files?per_page=100`,
    ),
    value.headSha
      ? pullRequestCi(config, value.headSha)
      : Promise.resolve<RenovateCi>("none"),
  ]);
  const updates = updatesFromFiles(Array.isArray(files) ? files : [], value.body);
  if (!updates.length) return null;
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    branch: value.branch,
    author: value.author,
    headSha: value.headSha,
    draft: value.draft,
    automerge: automergeEnabled(value.body),
    requiresWorker: requiresWorker(updates),
    ci,
    type: highestType(updates),
    updates,
    containers: [],
  };
}

/** Reads open Renovate pull requests that change Compose images. */
export async function fetchRenovatePullRequests(
  config: GithubConfig,
): Promise<RenovatePullRequest[]> {
  const raw = await githubJson<unknown[]>(
    config,
    `/repos/${config.repository}/pulls?state=open&per_page=100`,
  );
  const candidates = (Array.isArray(raw) ? raw : [])
    .map((entry) => candidate(entry))
    .filter((entry): entry is Candidate => entry !== null);
  const resolved = await Promise.all(
    candidates.map((entry) => pullRequest(config, entry)),
  );
  return resolved
    .filter((entry): entry is RenovatePullRequest => entry !== null)
    .sort((left, right) => left.number - right.number);
}

/**
 * Joins pull requests and containers by the Compose service label, never by
 * the image string: local images, security pins, retained versions and
 * untagged images all still point at the service Renovate edits.
 */
export function relatedContainers(
  updates: Array<{ file: string; service: string }>,
  containers: RenovateContainer[],
): RenovateContainer[] {
  const byService = new Map<string, RenovateContainer[]>();
  for (const container of containers) {
    const list = byService.get(container.service) ?? [];
    list.push(container);
    byService.set(container.service, list);
  }
  const seen = new Set<string>();
  const related: RenovateContainer[] = [];
  for (const update of updates) {
    const project = projectForFile(update.file);
    for (const container of byService.get(update.service) ?? []) {
      if (project && container.project !== project) continue;
      const key = `${container.hostId}:${container.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      related.push(container);
    }
  }
  return related;
}

export function relatePullRequests(
  prs: RenovatePullRequest[],
  containers: RenovateContainer[],
): RenovatePullRequest[] {
  return prs.map((pr) => ({
    ...pr,
    containers: relatedContainers(pr.updates, containers),
  }));
}

/** GitHub pull request fields needed to validate a merge without mutating it. */
export type GithubPullRequestDetail = {
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  body: string;
};

/**
 * Reads one Renovate pull request. Returns null for a missing PR or a PR that
 * is not a Renovate update, so the merge route never touches another author.
 */
export async function fetchRenovatePullRequest(
  config: GithubConfig,
  number: number,
): Promise<GithubPullRequestDetail | null> {
  let data: unknown;
  try {
    data = await githubJson<unknown>(
      config,
      `/repos/${config.repository}/pulls/${number}`,
    );
  } catch (error) {
    if (error instanceof GithubUnavailable && error.status === 404) return null;
    throw error;
  }
  const raw = asRecord(data);
  if (!raw) return null;
  const user = asRecord(raw.user);
  const head = asRecord(raw.head);
  const login = text(user?.login);
  const branch = text(head?.ref);
  const headSha = text(head?.sha);
  if (!login || !branch || !headSha) return null;
  if (!isRenovateAuthor(login) || !branch.startsWith("renovate/")) return null;
  const mergedAt = text(raw.merged_at);
  return {
    number,
    title: text(raw.title) ?? `#${number}`,
    url:
      text(raw.html_url) ??
      `https://github.com/${config.repository}/pull/${number}`,
    branch,
    author: login,
    state: text(raw.state) ?? "unknown",
    draft: raw.draft === true,
    merged: raw.merged === true || mergedAt !== null,
    mergedAt,
    mergeCommitSha: text(raw.merge_commit_sha),
    headSha,
    mergeable: typeof raw.mergeable === "boolean" ? raw.mergeable : null,
    mergeableState: text(raw.mergeable_state),
    body: text(raw.body) ?? "",
  };
}

export const fetchPullRequestChecks = pullRequestCi;

export type MergedRenovatePullRequest = RenovatePullRequest & {
  merged: true;
  mergedAt: string;
  mergeCommitSha: string;
};

/**
 * Reads already merged Renovate updates so the progress view can show the
 * pull requests Renovate merges on its own while they deploy.
 */
export async function fetchMergedRenovatePullRequests(
  config: GithubConfig,
  since: Date,
): Promise<MergedRenovatePullRequest[]> {
  const raw = await githubJson<unknown[]>(
    config,
    `/repos/${config.repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
  );
  const candidates: Array<{
    candidate: Candidate;
    mergedAt: string;
    mergeCommitSha: string;
  }> = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const entry = candidate(value, false);
    const record = asRecord(value);
    // GitHub's pull list omits the `merged` boolean; a non-null merged_at is
    // the authoritative merge signal there (the detail endpoint has both).
    const mergedAt = text(record?.merged_at);
    const mergeCommitSha = text(record?.merge_commit_sha);
    if (!entry || !mergedAt || !mergeCommitSha) continue;
    const at = new Date(mergedAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < since.getTime()) continue;
    candidates.push({ candidate: entry, mergedAt, mergeCommitSha });
  }
  const resolved = await Promise.all(
    candidates.slice(0, 20).map(
      async (entry): Promise<MergedRenovatePullRequest | null> => {
      // The PR's own CI is historical after the merge. Only the files are
      // needed here; the progress uses CI on main for the merge commit.
      const files = await githubJson<RawFile[]>(
        config,
        `/repos/${config.repository}/pulls/${entry.candidate.number}/files?per_page=100`,
      );
      const updates = updatesFromFiles(
        Array.isArray(files) ? files : [],
        entry.candidate.body,
      );
      if (!updates.length) return null;
      return {
        number: entry.candidate.number,
        title: entry.candidate.title,
        url: entry.candidate.url,
        branch: entry.candidate.branch,
        author: entry.candidate.author,
        headSha: entry.candidate.headSha,
        draft: entry.candidate.draft,
        automerge: automergeEnabled(entry.candidate.body),
        requiresWorker: requiresWorker(updates),
        ci: "none" as RenovateCi,
        type: highestType(updates),
        updates,
        containers: [],
        merged: true as const,
        mergedAt: entry.mergedAt,
        mergeCommitSha: entry.mergeCommitSha,
      };
    }),
  );
  return resolved
    .filter((entry): entry is MergedRenovatePullRequest => entry !== null)
    .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
}

const RELEASE_CACHE_MS = 30_000;
const RELEASE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const RELEASE_LIMIT = 10;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

let releaseCache: {
  key: string;
  at: number;
  releases: DeployRelease[];
} | null = null;
const compareCache = new Map<string, boolean>();

/** Clears the short-lived GitHub release cache (tests and configuration reloads). */
export function resetGithubCaches() {
  releaseCache = null;
  compareCache.clear();
}

async function releaseManifest(
  config: GithubConfig,
  release: { tag: string; url: string; publishedAt: string | null },
): Promise<DeployRelease | null> {
  let data: unknown;
  try {
    data = await githubJson<unknown>(
      config,
      `/repos/${config.repository}/contents/docs/releases/${encodeURIComponent(
        release.tag,
      )}.deploy.json?ref=${encodeURIComponent(release.tag)}`,
    );
  } catch (error) {
    // Releases published before the manifest existed are not deployable.
    if (error instanceof GithubUnavailable && error.status === 404) return null;
    throw error;
  }
  const raw = asRecord(data);
  const content = text(raw?.content);
  if (!content) return null;
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8"),
    );
  } catch {
    return null;
  }
  const record = asRecord(manifest);
  if (!record || record.schema !== 1 || record.approved_merge !== true)
    return null;
  const sourceCommit = text(record.source_commit);
  if (!sourceCommit || !/^[a-f0-9]{40}$/.test(sourceCommit)) return null;
  const roles = (Array.isArray(record.roles) ? record.roles : []).filter(
    (role): role is HostRole =>
      role === "instance" || role === "apps-server",
  );
  return {
    tag: release.tag,
    url: release.url,
    publishedAt: release.publishedAt,
    sourceCommit,
    roles,
  };
}

/**
 * Reads published stable releases and their deployment manifests. This is the
 * "release with manifest" side of the six-step progress; manifests are cached
 * briefly so polling the progress does not multiply GitHub requests.
 */
export async function fetchDeployReleases(
  config: GithubConfig,
  now = Date.now(),
): Promise<DeployRelease[]> {
  const key = `${config.apiUrl}|${config.repository}`;
  if (
    releaseCache &&
    releaseCache.key === key &&
    now - releaseCache.at < RELEASE_CACHE_MS
  )
    return releaseCache.releases;

  const raw = await githubJson<unknown[]>(
    config,
    `/repos/${config.repository}/releases?per_page=30`,
  );
  const releases: Array<{
    tag: string;
    url: string;
    publishedAt: string | null;
  }> = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const record = asRecord(value);
    if (!record) continue;
    const tag = text(record.tag_name);
    if (!tag || !STABLE_TAG.test(tag)) continue;
    if (record.draft === true || record.prerelease === true) continue;
    const publishedAt =
      text(record.published_at) ?? text(record.created_at);
    if (!publishedAt) continue;
    const at = new Date(publishedAt).getTime();
    if (Number.isNaN(at) || at < now - RELEASE_WINDOW_MS) continue;
    releases.push({
      tag,
      url:
        text(record.html_url) ??
        `https://github.com/${config.repository}/releases/tag/${tag}`,
      publishedAt,
    });
  }

  const manifests = await Promise.all(
    releases
      .slice(0, RELEASE_LIMIT)
      .map((release) => releaseManifest(config, release)),
  );
  const result = manifests
    .filter((release): release is DeployRelease => release !== null)
    .sort((left, right) =>
      (right.publishedAt ?? "").localeCompare(left.publishedAt ?? ""),
    );
  releaseCache = { key, at: now, releases: result };
  return result;
}

/**
 * True when the release source commit already contains the merge that started
 * this update. GitHub compares base...head, so "ahead" and "identical" mean
 * the release was cut at or after that merge.
 */
export async function releaseContainsCommit(
  config: GithubConfig,
  commit: string,
  release: DeployRelease,
): Promise<boolean> {
  if (release.sourceCommit === commit) return true;
  const key = `${config.apiUrl}|${config.repository}|${commit}|${release.sourceCommit}`;
  const cached = compareCache.get(key);
  if (cached !== undefined) return cached;
  const data = await githubJson<{ status?: unknown }>(
    config,
    `/repos/${config.repository}/compare/${commit}...${release.sourceCommit}`,
  );
  const status = text(data.status);
  const contains = status === "ahead" || status === "identical";
  compareCache.set(key, contains);
  return contains;
}
