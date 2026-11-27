import { tr } from "../../shared/language";
import type { Category, Skill } from "../../shared/library";

const KNOWN_HOSTS: Record<string, string> = {
  "github.com": "GitHub",
  "www.github.com": "GitHub",
  "gitlab.com": "GitLab",
  "www.gitlab.com": "GitLab",
  "gitee.com": "Gitee",
  "www.gitee.com": "Gitee",
  "bitbucket.org": "Bitbucket",
  "www.bitbucket.org": "Bitbucket",
};

const DEFAULT_REFERENCES = new Set([
  "refs/heads/main",
  "refs/heads/master",
  "main",
  "master",
]);

function stripGitSuffix(value: string): string {
  return value.replace(/\/+$/, "").replace(/\.git$/i, "");
}

function hostDisplayName(host: string): string {
  return KNOWN_HOSTS[host.toLowerCase()] ?? host;
}

/** Extract a concise display title from a Git repository URL or identifier. */
export function packageTitle(repository: string): string {
  const cleaned = stripGitSuffix(repository.trim());
  const segments = cleaned.split(/[/:]/).filter(Boolean);
  return segments.at(-1) || repository;
}

/** Format a Git URL or SSH remote into a beginner-friendly source label. */
export function formatSourceOrigin(repository: string): string {
  const trimmed = repository.trim();
  const scp = /^[^@\s]+@([^:\s/]+):(.+)$/.exec(trimmed);
  if (scp) {
    const [, host, rawPath] = scp;
    const cleanPath = stripGitSuffix(rawPath.replace(/^\/+/, ""));
    const label = hostDisplayName(host);
    return cleanPath ? `${label} · ${cleanPath}` : label;
  }
  try {
    const url = new URL(trimmed);
    const label = hostDisplayName(url.hostname);
    const cleanPath = stripGitSuffix(url.pathname.replace(/^\/+/, ""));
    return cleanPath ? `${label} · ${cleanPath}` : label;
  } catch {
    return stripGitSuffix(trimmed) || trimmed;
  }
}

/** Format a Git reference when it adds useful context beyond the default branch. */
export function formatReference(reference: string | null | undefined): string | null {
  if (!reference) return null;
  const trimmed = reference.trim();
  if (!trimmed || DEFAULT_REFERENCES.has(trimmed)) return null;
  if (trimmed.startsWith("refs/heads/")) {
    const branch = trimmed.slice("refs/heads/".length);
    return tr(`分支：${branch}`, `Branch: ${branch}`);
  }
  if (trimmed.startsWith("refs/tags/")) {
    const tag = trimmed.slice("refs/tags/".length);
    return tr(`版本：${tag}`, `Tag: ${tag}`);
  }
  if (/^[0-9a-f]{12,40}$/i.test(trimmed)) {
    return tr(`固定版本：${trimmed.slice(0, 7)}`, `Pinned: ${trimmed.slice(0, 7)}`);
  }
  return tr(`版本：${trimmed}`, `Ref: ${trimmed}`);
}

/** Format installed skill names for a package row, truncating after three entries. */
export function formatInstalledSkills(
  members: Skill[],
  totalCount: number,
): { text: string; title?: string } {
  if (!members.length) {
    return {
      text: tr(
        `已安装 ${totalCount} 个 Skill`,
        totalCount === 1 ? "1 skill installed" : `${totalCount} skills installed`,
      ),
    };
  }
  const separator = tr("、", ", ");
  if (members.length <= 3) {
    const names = members.map((skill) => skill.name).join(separator);
    return {
      text: tr(
        `已安装 ${members.length} 个 Skill：${names}`,
        `${members.length} ${members.length === 1 ? "skill" : "skills"} installed: ${names}`,
      ),
    };
  }
  const firstThree = members.slice(0, 3).map((skill) => skill.name).join(separator);
  const allNames = members.map((skill) => skill.name).join(separator);
  return {
    text: tr(
      `已安装 ${members.length} 个 Skill：${firstThree} 等`,
      `${members.length} skills installed: ${firstThree}, and ${members.length - 3} more`,
    ),
    title: allNames,
  };
}

/** Format named categories for package members, suppressing all-uncategorized noise. */
export function formatCategories(members: Skill[], categories: Category[]): string | null {
  if (!members.length) return null;
  const byId = new Map(categories.map((category) => [category.id, category.name]));
  const named = new Set<string>();
  let hasUncategorized = false;
  for (const skill of members) {
    const name = skill.categoryId ? byId.get(skill.categoryId) : undefined;
    if (name) named.add(name);
    else hasUncategorized = true;
  }
  if (!named.size) return null;
  const list = [...named];
  if (hasUncategorized) list.push(tr("未分类", "Uncategorized"));
  return tr(
    `分类：${list.join("、")}`,
    `${list.length === 1 ? "Category" : "Categories"}: ${list.join(", ")}`,
  );
}

/** Full repository and reference string preserved for hover inspection. */
export function sourceTooltip(repository: string, reference: string | null | undefined): string {
  return reference ? `${repository} (${reference})` : repository;
}

/** Format an upstream commit Unix timestamp (seconds) into a localized update time label. */
export function formatUpdateTime(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return null;
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = date.toLocaleString(document.documentElement.lang || undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return tr(`更新于 ${formatted}`, `Updated ${formatted}`);
}

/** Normalize an HTTPS Git repository remote URL into a browsable web URL. */
export function formatRepositoryUrl(repository: string): string | null {
  try {
    const url = new URL(repository.trim());
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    const port = url.port ? `:${url.port}` : "";
    const cleanPath = stripGitSuffix(url.pathname);
    if (!cleanPath || cleanPath === "/") return null;
    return `https://${url.hostname}${port}${cleanPath}`;
  } catch {
    return null;
  }
}

function isCommitHash(value: string | null | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{40}$/i.test(value));
}

/** Build a web URL showing the commit diff or commit details for common Git hosts. */
export function formatSourceDiffUrl(
  repository: string,
  fromRevision: string | null | undefined,
  toRevision: string | null | undefined,
): string | null {
  const baseUrl = formatRepositoryUrl(repository);
  if (!baseUrl) return null;
  const to = isCommitHash(toRevision) ? toRevision : null;
  const from = isCommitHash(fromRevision) && fromRevision !== to ? fromRevision : null;
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return baseUrl;
  }
  if (host === "github.com" || host === "www.github.com" || host === "gitee.com" || host === "www.gitee.com") {
    if (from && to) return `${baseUrl}/compare/${from}...${to}`;
    if (to) return `${baseUrl}/commit/${to}`;
    return baseUrl;
  }
  if (host === "gitlab.com" || host === "www.gitlab.com" || host.includes("gitlab")) {
    if (from && to) return `${baseUrl}/-/compare/${from}...${to}`;
    if (to) return `${baseUrl}/-/commit/${to}`;
    return baseUrl;
  }
  if (host === "bitbucket.org" || host === "www.bitbucket.org") {
    if (from && to) return `${baseUrl}/branches/compare/${to}..${from}`;
    if (to) return `${baseUrl}/commits/${to}`;
    return baseUrl;
  }
  return baseUrl;
}

/** Format a compact short-hash range such as `d653911 → 6f7f783`. */
export function formatShortRevisionRange(
  fromRevision: string | null | undefined,
  toRevision: string | null | undefined,
): string | null {
  const to = toRevision?.trim();
  const from = fromRevision?.trim();
  if (!to && !from) return null;
  if (from && to && from !== to) {
    return `${from.slice(0, 7)} → ${to.slice(0, 7)}`;
  }
  return (to || from)!.slice(0, 7);
}
