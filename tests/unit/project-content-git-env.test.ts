import { expect, test } from "bun:test";
import { projectGitEnvironment } from "../../src/server/project-content/git/process.js";

test("project Git subprocess environment excludes credentials and ambient repository/config overrides", () => {
  const env = projectGitEnvironment({
    PATH: "/usr/bin",
    HOME: "/private/home",
    CODEX_HOME: "/private/model",
    TOKEN: "secret",
    GIT_DIR: "/foreign",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.sshCommand",
    GIT_CONFIG_VALUE_0: "unsafe",
  });
  expect(env.PATH).toBe("/usr/bin");
  for (const key of ["HOME", "CODEX_HOME", "TOKEN", "GIT_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_VALUE_0"])
    expect(env[key]).toBeUndefined();
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
});
