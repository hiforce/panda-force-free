const repositoryHosts = new Set(["github.com", "gitlab.com", "codeberg.org", "gitee.com", "bitbucket.org"]);

export function memoryLinks(text: string) {
  return [...text.matchAll(/\bhttps?:\/\/[^\s<>"'`)[\]{}，。；！？、）]*/giu)].map((match) => ({
    url: match[0].replace(/[.,;:!?]+$/u, ""),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

export function isMemoryRepositoryLink(text: string) {
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      repositoryHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      !/[?#]/u.test(text) &&
      /^\/[\w.-]+\/[\w.-]+\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}
