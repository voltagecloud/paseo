import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubService,
  resolveRepositoryToken,
  GitHubAuthenticationError,
  GitHubCliMissingError,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
} from "./github-service.js";

interface RunnerCall {
  args: string[];
  options: GitHubCommandRunnerOptions;
}

function createRunner(outputs: string[]): { calls: RunnerCall[]; runner: GitHubCommandRunner } {
  const calls: RunnerCall[] = [];
  return {
    calls,
    runner: async (args, options) => {
      calls.push({ args, options });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    },
  };
}

describe("GitHub repository search", () => {
  it("lists recent owned repositories for an empty query and normalizes clone identity", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: " R_recent ",
          name: " paseo ",
          nameWithOwner: " getpaseo/paseo ",
          description: null,
          isPrivate: false,
          updatedAt: "2026-07-15T12:00:00Z",
          sshUrl: " git@github.com:getpaseo/paseo.git ",
          url: "https://github.com/getpaseo/paseo",
        },
      ]),
      "ssh\n",
    ]);
    const service = createGitHubService({
      resolveRepositoryToken: async () => null,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.searchRepositories({ cwd: "/tmp", query: "  ", limit: 8 }),
    ).resolves.toEqual([
      {
        id: "R_recent",
        name: "paseo",
        nameWithOwner: "getpaseo/paseo",
        description: null,
        visibility: "public",
        updatedAt: "2026-07-15T12:00:00Z",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      },
    ]);
    expect(runner.calls).toEqual([
      {
        args: [
          "repo",
          "list",
          "--json",
          "id,name,nameWithOwner,description,isPrivate,updatedAt,sshUrl,url",
          "--limit",
          "8",
        ],
        options: { cwd: "/tmp" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp" },
      },
    ]);
  });

  it("searches accessible repositories for a typed query", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: 42,
          name: "private-repo",
          fullName: "octo/private-repo",
          description: "Private project",
          isPrivate: true,
          updatedAt: "2026-07-14T08:00:00Z",
          url: "https://github.com/octo/private-repo",
        },
      ]),
      "https",
    ]);
    const service = createGitHubService({
      resolveRepositoryToken: async () => null,
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.searchRepositories({ cwd: "/tmp", query: " private project ", limit: 5 }),
    ).resolves.toEqual([
      {
        id: "42",
        name: "private-repo",
        nameWithOwner: "octo/private-repo",
        description: "Private project",
        visibility: "private",
        updatedAt: "2026-07-14T08:00:00Z",
        cloneUrl: "https://github.com/octo/private-repo",
      },
    ]);
    expect(runner.calls).toEqual([
      {
        args: [
          "search",
          "repos",
          "private project",
          "--json",
          "id,name,fullName,description,isPrivate,updatedAt,url",
          "--sort",
          "updated",
          "--order",
          "desc",
          "--limit",
          "5",
        ],
        options: { cwd: "/tmp" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp" },
      },
    ]);
  });
});

const apiRepository = {
  node_id: "R_private",
  name: "private-repo",
  full_name: "octo/private-repo",
  description: "Private project",
  private: true,
  updated_at: "2026-07-14T08:00:00Z",
  ssh_url: "git@github.com:octo/private-repo.git",
  clone_url: "https://github.com/octo/private-repo.git",
};

describe("token repository discovery", () => {
  it("filters token-visible repositories across pages without gh", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          [{ ...apiRepository, name: "unrelated", full_name: "octo/unrelated", description: null }],
          {
            headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json([apiRepository]));
    const service = createGitHubService({
      resolveRepositoryToken: async () => "test-token",
      resolveGhPath: async () => null,
      repositoryFetch: request,
    });
    await expect(
      service.searchRepositories({ cwd: "/tmp", query: " PRIVATE PROJECT ", limit: 1 }),
    ).resolves.toEqual([
      {
        id: "R_private",
        name: "private-repo",
        nameWithOwner: "octo/private-repo",
        description: "Private project",
        visibility: "private",
        updatedAt: apiRepository.updated_at,
        cloneUrl: apiRepository.clone_url,
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [url, init] of request.mock.calls) {
      expect(String(url)).toContain(
        "https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=",
      );
      expect(init?.headers).toEqual({
        Authorization: "Bearer test-token",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      expect(init?.redirect).toBe("error");
    }
    expect(String(request.mock.calls[1][0])).toContain("page=2");
  });

  it("preserves the gh SSH preference while using token discovery", async () => {
    const runner = createRunner(["ssh"]);
    const service = createGitHubService({
      resolveRepositoryToken: async () => "test-token",
      resolveGhPath: async () => "/usr/bin/gh",
      runner: runner.runner,
      repositoryFetch: async () => Response.json([apiRepository]),
    });
    const result = await service.searchRepositories({
      cwd: "/tmp",
      query: "OCTO/PRIVATE",
      limit: 1,
    });
    expect(result.map((repo) => repo.cloneUrl)).toEqual([apiRepository.ssh_url]);
    expect(runner.calls.map((call) => call.args)).toEqual([
      ["config", "get", "git_protocol", "--host", "github.com"],
    ]);
  });

  it("keeps missing credentials unavailable without making an anonymous request", async () => {
    const request = vi.fn<typeof fetch>();
    const service = createGitHubService({
      resolveRepositoryToken: async () => null,
      resolveGhPath: async () => null,
      repositoryFetch: request,
    });
    await expect(service.searchRepositories({ cwd: "/tmp", query: "" })).rejects.toBeInstanceOf(
      GitHubCliMissingError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("maps rejected credentials to unauthenticated without returning the response body", async () => {
    const service = createGitHubService({
      resolveRepositoryToken: async () => "test-token",
      resolveGhPath: async () => null,
      repositoryFetch: async () => new Response("sensitive body", { status: 401 }),
    });
    await expect(service.searchRepositories({ cwd: "/tmp", query: "" })).rejects.toBeInstanceOf(
      GitHubAuthenticationError,
    );
  });

  it.each([403, 429, 500])("reports HTTP %s without response content", async (status) => {
    const service = createGitHubService({
      resolveRepositoryToken: async () => "test-token",
      resolveGhPath: async () => null,
      repositoryFetch: async () => new Response("sensitive body", { status }),
    });
    await expect(service.searchRepositories({ cwd: "/tmp", query: "" })).rejects.toThrow(
      `GitHub repository listing failed (HTTP ${status}). Check token access and rate limits.`,
    );
  });

  it("sanitizes network failures", async () => {
    const service = createGitHubService({
      resolveRepositoryToken: async () => "test-token",
      resolveGhPath: async () => null,
      repositoryFetch: async () => {
        throw new Error("test-token");
      },
    });
    await expect(service.searchRepositories({ cwd: "/tmp", query: "" })).rejects.toThrow(
      "GitHub repository listing failed. Check the host network connection and retry.",
    );
  });

  it("finds a scoped match beyond 1,000 repositories and stops when enough match", async () => {
    const unrelated = Array.from({ length: 100 }, () => ({
      ...apiRepository,
      name: "unrelated",
      full_name: "octo/unrelated",
      description: null,
    }));
    let page = 0;
    const request = vi.fn<typeof fetch>().mockImplementation(async () => {
      page++;
      return Response.json(page <= 10 ? unrelated : [apiRepository], {
        headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
      });
    });
    const service = createGitHubService({
      resolveRepositoryToken: async () => "test-token",
      resolveGhPath: async () => null,
      repositoryFetch: request,
    });
    const result = await service.searchRepositories({ cwd: "/tmp", query: "private", limit: 1 });
    expect(result.map((repo) => repo.id)).toEqual(["R_private"]);
    expect(request).toHaveBeenCalledTimes(11);
  });

  it("fails clearly and cancels discovery when its deadline expires", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    try {
      const service = createGitHubService({
        resolveRepositoryToken: async () => "test-token",
        resolveGhPath: async () => null,
        repositoryFetch: request,
      });
      await expect(service.searchRepositories({ cwd: "/tmp", query: "private" })).rejects.toThrow(
        "timed out before completion",
      );
      expect(request).toHaveBeenCalledTimes(1);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("keeps an empty scoped search authoritative when gh is available", async () => {
    const runner = createRunner(["https"]);
    const service = createGitHubService({
      resolveRepositoryToken: async () => "selected-repositories-token",
      resolveGhPath: async () => "/usr/bin/gh",
      runner: runner.runner,
      repositoryFetch: async () => Response.json([apiRepository]),
    });
    await expect(
      service.searchRepositories({ cwd: "/tmp", query: "other-public-project" }),
    ).resolves.toEqual([]);
    expect(runner.calls.map((call) => call.args[0])).toEqual(["config"]);
  });
});

it("resolves host-only Git credentials before environment fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-credentials-"));
  const config = join(directory, "gitconfig");
  try {
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    vi.stubEnv("GH_TOKEN", "env-token");
    vi.stubEnv("GITHUB_TOKEN", "secondary-token");
    await writeFile(
      config,
      `[credential]\nhelper = "!printf 'username=test\\npassword=helper-token\\n'"\n`,
    );
    await expect(resolveRepositoryToken(directory)).resolves.toBe("helper-token");
    await writeFile(config, "[credential]\nhelper =\n");
    await expect(resolveRepositoryToken(directory)).resolves.toBe("env-token");
    vi.stubEnv("GH_TOKEN", "");
    await expect(resolveRepositoryToken(directory)).resolves.toBe("secondary-token");
    vi.stubEnv("GITHUB_TOKEN", "");
    await expect(resolveRepositoryToken(directory)).resolves.toBeNull();
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("falls back when a Git credential helper stalls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-stalled-credentials-"));
  const config = join(directory, "gitconfig");
  try {
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    vi.stubEnv("GH_TOKEN", "fallback-token");
    await writeFile(config, '[credential]\nhelper = "!f() { sleep 30; }; f"\n');
    await expect(resolveRepositoryToken(directory)).resolves.toBe("fallback-token");
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

it("does not route token discovery through workspace authentication", async () => {
  const resolveRepoHost = vi.fn(async () => {
    throw new GitHubAuthenticationError({ stderr: "unrelated origin" });
  });
  const service = createGitHubService({
    resolveRepositoryToken: async () => "test-token",
    resolveGhPath: async () => "/usr/bin/gh",
    resolveRepoHost,
    runner: async () => {
      throw new Error("preference unavailable");
    },
    repositoryFetch: async () => Response.json([apiRepository]),
  });
  const result = await service.searchRepositories({ cwd: "/tmp", query: "" });
  expect(result.map((repo) => repo.cloneUrl)).toEqual([apiRepository.clone_url]);
  expect(resolveRepoHost).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")(
  "terminates an orphaned credential pipe holder",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-orphan-credentials-"));
    const config = join(directory, "gitconfig");
    try {
      vi.stubEnv("GIT_CONFIG_GLOBAL", config);
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
      vi.stubEnv("GIT_CONFIG_COUNT", "0");
      vi.stubEnv("GH_TOKEN", "fallback-token");
      await writeFile(
        config,
        '[credential]\nhelper = "!f() { sleep 30 & echo $! > helper.pid; }; f"\n',
      );
      await expect(resolveRepositoryToken(directory)).resolves.toBe("fallback-token");
      const pid = Number(await readFile(join(directory, "helper.pid"), "utf8"));
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000 });
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  10_000,
);

it.skipIf(process.platform !== "win32")(
  "Windows job terminates a pipe holder after Git exits",
  async () => {
    const { spawnWindowsCredentialProcess } = await import("../utils/windows-job-process.js");
    const directory = await mkdtemp(join(tmpdir(), "paseo-windows-job-"));
    const script = join(directory, "parent.cjs");
    await writeFile(
      script,
      `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
writeFileSync('parent.pid', String(process.pid));
const holder = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('holder.pid', String(process.pid)); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'ignore'] });
holder.unref();
`,
    );
    const trace = join(directory, "git-trace.jsonl");
    const shellQuote = (value: string) =>
      "'" + value.replaceAll("\\", "/").replaceAll("'", "'\"'\"'") + "'";
    const alias = `alias.pipe=!${shellQuote(process.execPath)} ${shellQuote(script)}`;
    const child = spawnWindowsCredentialProcess("git", ["-c", alias, "pipe"], {
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
      envOverlay: { GIT_TRACE2_EVENT: trace, GIT_TRACE2_PARENT_SID: "" },
    });
    let closed = false;
    child.on("close", () => {
      closed = true;
    });
    child.on("error", () => {
      closed = true;
    });
    let holderPid = 0;
    try {
      await vi.waitFor(
        async () => {
          holderPid = Number(await readFile(join(directory, "holder.pid"), "utf8"));
          expect(holderPid).toBeGreaterThan(0);
        },
        { timeout: 15_000 },
      );
      const parentPid = Number(await readFile(join(directory, "parent.pid"), "utf8"));
      await vi.waitFor(() => expect(() => process.kill(parentPid, 0)).toThrow());
      const traceText = await readFile(trace, "utf8");
      const gitPid = Number.parseInt(
        traceText.match(/"sid":"[^"/]*-P([0-9a-fA-F]+)"/)?.[1] ?? "",
        16,
      );
      expect(gitPid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(gitPid, 0)).toThrow());
      expect(closed).toBe(false);
      expect(() => process.kill(holderPid, 0)).not.toThrow();
      child.kill("SIGKILL");
      await vi.waitFor(() => expect(() => process.kill(holderPid, 0)).toThrow(), { timeout: 5000 });
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      child.kill("SIGKILL");
      if (holderPid) {
        try {
          process.kill(holderPid, "SIGKILL");
        } catch {
          /* Already terminated. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);
