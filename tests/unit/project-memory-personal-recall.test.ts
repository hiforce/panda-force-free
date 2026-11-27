import { expect, test } from "bun:test";
import type { MemoryEntry } from "../../src/shared/project-memory/contracts.js";
import { modelExcerpt, organizationSourceExcerpts } from "../../src/server/project-memory/model-review.js";
import { organizationCli } from "../../src/server/project-memory/organization-tools.js";
import { personalRecallMatches, personalRecallTopics } from "../../src/server/project-memory/personal-recall.js";
import { matchingMemories, projectMemoryMatcher } from "../../src/server/project-memory/projection.js";

const source = "ordinary-source";
function memory(key: string, scope = "project", value = key): MemoryEntry {
  return {
    id: key + "/" + scope,
    key,
    scope,
    version: value,
    value,
    state: "active",
    sources: [{ conversationId: source, messageId: key }],
  };
}

test("natural personal questions recall legacy and project memories without internal keys or a ready index", () => {
  const records = [
    memory("user-food-preferences", "user"),
    memory("user-profession", "user"),
    memory("user-profile", "user"),
    memory("user-hobbies"),
    memory("build-timeout"),
    { ...memory("member-profile"), team: true as const },
  ];
  for (const prompt of [
    "你还记得我的个人信息和兴趣吗？",
    "你目前对我有多少了解？",
    "你而家對我有幾多了解？",
    "你現在對我有多少瞭解？",
    "How much do you know about me",
    "你還記得我的個人資料和興趣嗎？",
    "What do you remember about me and my interests?",
  ]) {
    const found = matchingMemories(
      records,
      projectMemoryMatcher(prompt)!,
      "other-conversation",
      () => false,
      personalRecallMatches(prompt),
    );
    expect(found.map(({ key }) => key)).toEqual([
      "user-profile",
      "user-profession",
      "user-hobbies",
      "user-food-preferences",
    ]);
  }
  const food = "你还记得我喜欢吃什么吗？";
  expect(
    matchingMemories(
      records,
      projectMemoryMatcher(food)!,
      "other-conversation",
      () => false,
      personalRecallMatches(food),
    ).map(({ key }) => key),
  ).toEqual(["user-food-preferences"]);
  for (const prompt of [
    "Summarize the project profile",
    "关于我的工作流，你知道哪些问题？",
    "你对我的工作目录了解多少？",
    "你对这个项目了解多少？",
    "What is my work directory?",
  ])
    expect(personalRecallTopics(prompt)).toEqual([]);
  const overview = "What do you remember about me?";
  expect(
    matchingMemories(records, projectMemoryMatcher(overview)!, source, () => false, personalRecallMatches(overview)),
  ).toEqual([]);
});

test("personal recall follow-ups keep the last explicit question and stop at a topic change", () => {
  const anchor = "What do you remember about me?";
  const profile = memory("user-profile");
  for (const query of ["还有没有补充？", "還有沒有補充？", "仲有冇補充？", "Any updates?"]) {
    expect(personalRecallMatches(query, [anchor, "Anything else?"])?.(profile)).toBe(0);
    expect(personalRecallMatches(query, [anchor, "What is the release schedule?"])).toBeUndefined();
    expect(personalRecallMatches(query)).toBeUndefined();
  }
  expect(personalRecallMatches("Show me the release schedule.", [anchor])).toBeUndefined();
});

test("organization sends only contiguous text from a message with a link", () => {
  const statement = "I grow alpine plants. https://example.test/archive I collect old maps.";
  expect(modelExcerpt(statement)).toBeNull();
  expect(organizationSourceExcerpts(statement)).toEqual(["I grow alpine plants.", "I collect old maps."]);
  expect(organizationSourceExcerpts("https://example.test/archive")).toEqual([]);
  expect(organizationSourceExcerpts("I grow alpine plants. https://example.test/archive\n> Quoted content")).toEqual(
    [],
  );
  expect(
    organizationSourceExcerpts("I grow alpine plants. https://example.test/archive API key: fixture-value"),
  ).toEqual([]);
});

test("repository addresses can be recorded and recalled with their authored project", async () => {
  const url = "https://github.com/example/meridian";
  const authored = `I maintain Meridian, an open-source tool: ${url}.`;
  expect(organizationSourceExcerpts(authored)).toEqual([authored]);
  expect(
    organizationSourceExcerpts(`${authored} https://github.com/example/private#private-section I maintain tool docs.`),
  ).toEqual([authored, "I maintain tool docs."]);
  const context = { job: "e".repeat(32), existing: [], sources: [{ id: "source", user: authored }] };
  const proposal = {
    key: "user-open-source-project-meridian",
    sourceId: "source",
    value: `Maintains Meridian: ${url}`,
    quote: authored,
  };
  const cli = organizationCli(context);
  await cli.submit(JSON.stringify({ entries: [proposal] }));
  expect(cli.result()?.[0]?.value).toContain(url);
  for (const value of ["https://github.com/example/another-project", `${url}?token=signed`]) {
    await expect(
      organizationCli(context).submit(JSON.stringify({ entries: [{ ...proposal, value }] })),
    ).rejects.toMatchObject({ code: "invalidInput" });
  }
  const entry = memory(proposal.key);
  expect(personalRecallMatches("你知道我做了哪些开源项目？")?.(entry)).toBe(0);
  expect(personalRecallMatches("還有沒有補充？", ["你對我了解多少？"])?.(entry)).toBeGreaterThanOrEqual(0);
});

test("legacy project aliases re-use identity and different qualified values remain isolated", () => {
  const title = "Favorite foods";
  const same = memory("user-food-preferences", "user", "Yuzu tea");
  const current = { ...memory("user-food-preferences", "project", "Yuzu tea"), title };
  const named = memory("user-food-preferences", "release", "Coffee");
  const prompt = "What are my favorite foods?";
  const match = projectMemoryMatcher(prompt)!;
  expect(
    matchingMemories([same, current, named], match, "other", () => true, personalRecallMatches(prompt)),
  ).toHaveLength(1);
  expect(
    matchingMemories(
      [same, { ...current, value: "Black tea" }, named],
      match,
      "other",
      () => true,
      personalRecallMatches(prompt),
    ),
  ).toEqual([]);
});

test("organization creates project entries and updates a legacy memory without splitting its history", async () => {
  const job = "f".repeat(32);
  const sourceId = "source";
  const quote = "The favorite drink is yuzu tea.";
  const context = { job, existing: [], sources: [{ id: sourceId, user: quote }] };
  const proposal = { key: "user-food-preferences", value: "Yuzu tea", sourceId, quote };
  const create = organizationCli(context);
  await create.submit(JSON.stringify({ entries: [{ ...proposal, scope: "user" }] }));
  expect(create.result()).toMatchObject([{ scope: "project" }]);
  const edit = organizationCli({
    ...context,
    existing: [{ key: proposal.key, scope: "user", value: "Water", version: "prior" }],
  });
  await edit.submit(JSON.stringify({ entries: [{ ...proposal, action: "replace" }] }));
  expect(edit.result()).toMatchObject([{ scope: "user", replaces: true, expectedVersion: "prior" }]);
});
