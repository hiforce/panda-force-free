import { isProjectMemoryScope, type MemoryEntry } from "../../shared/project-memory/contracts.js";
import { visibleHarnessText } from "../../shared/harness/text.js";

type PersonalTopic = "profile" | "profession" | "projects" | "food" | "preferences";

// An explicit question about oneself can recall private profile facts from the current project.
export function personalRecallTopics(prompt: string): readonly PersonalTopic[] {
  const text = visibleHarnessText(prompt).normalize("NFKC").toLowerCase();
  if (
    /[你妳](?:[現现]在|目前|而家)?[對对]我(?:(?:有)?(?:多少|多深|幾多)的?(?:了解|瞭解)|(?:了解|瞭解)(?:多少|多深|幾多|甚麼|什么|哪些))(?=$|[\p{P}\s]|[嗎吗])/u.test(
      text,
    ) ||
    /[你妳](?:[現现]在|目前|而家)?(?:了解|瞭解)我(?:多少|多深|幾多)(?=$|[\p{P}\s])/u.test(text) ||
    /\bhow (?:much|well) do you (?:know|remember) about me\b/u.test(text)
  )
    return ["profile", "profession", "projects", "preferences", "food"];
  const chinese =
    /我(?:的|做|[開开][發发]|[維维][護护]|平[時时]|以前|曾|是|喜[歡欢]|[愛爱]吃|[對对]|[從从]事|有)/u.test(text);
  const english = /\b(?:my|about me|i (?:am|like|enjoy|prefer|work|do))\b/u.test(text);
  if (!chinese && !english) return [];
  if (
    !/[?？]|知道|[記记]得|[記记]住|[總总][結结]|告[訴诉]我|哪些|怎[麼么样樣]|[甚什][麼么]|[嗎吗]|\b(?:what|which|who|remember|recall|tell|summarize|summarise|list)\b/u.test(
      text,
    ) &&
    !/^(?:我的|my )[^\p{P}\n]{2,28}$/u.test(text)
  )
    return [];
  if (
    /(?:关于|關於)我(?:的(?:一切|情[況况]))?(?![\p{L}\p{N}])|我的(?:基本|個人|个人)?(?:信息|資訊|资料|資料|情況|情况|背景)(?=$|[\p{P}\s]|[和與与跟嗎吗])|\b(?:about me|my (?:profile|personal (?:information|details)|background))\b/u.test(
      text,
    )
  )
    return ["profile", "profession", "projects", "preferences", "food"];
  const topics: PersonalTopic[] = [];
  if (
    /[開开]源|副[業业][專专項项]目|個人[專专]案|\b(?:open.source projects?|side projects?|repositories)\b/u.test(text)
  )
    topics.push("projects");
  if (
    /[職职][業业位务務]|工作(?![流区區台臺目文])|[從从]事|\b(?:occupation|profession|job|career|work(?! (?:directory|folder|flow|space|project)))\b/u.test(
      text,
    )
  )
    topics.push("profession");
  if (/名字|姓名|生日|年[齡龄]|哪[裡裏里]人|\b(?:name|age|birthday|birthplace)\b/u.test(text)) topics.push("profile");
  if (/吃|喝|美食|食物|[飲饮]食|口味|\b(?:food|foods|eat|eating|dishes|cuisine|cuisines)\b/u.test(text))
    topics.push("food");
  else if (
    /[愛爱]好|[興兴]趣|嗜好|喜好|喜[歡欢]|\b(?:preferences?|hobb(?:y|ies)|interests?|enjoy|like|likes|favou?rites?)\b/u.test(
      text,
    )
  )
    topics.push("preferences", "food");
  return topics;
}

export function personalMemoryTopic({ key, scope }: Pick<MemoryEntry, "key" | "scope">): PersonalTopic | undefined {
  if (!isProjectMemoryScope(scope)) return;
  if (
    /(?:^|-)(?:open-source|personal|side)-(?:projects?|repos?(?:itory)?)(?:-|$)|[開开]源[專专項项]|個人[專专]案/u.test(
      key,
    )
  )
    return "projects";
  if (/(?:^|-)(?:food|foods|diet|cuisine|meal|dishes)(?:-|$)|美食|食物|[飲饮]食|口味|料理/u.test(key)) return "food";
  if (
    /(?:^|-)(?:preferences?|hobbies|hobby|interests?|likes|favou?rites?)(?:-|$)|[愛爱]好|[興兴]趣|嗜好|喜好/u.test(key)
  )
    return "preferences";
  if (/(?:^|-)(?:profession|occupation|career|job|work)(?:-|$)|[職职][業业位]|工作/u.test(key)) return "profession";
  if (
    /(?:^|-)(?:profile|identity|background|name|birthday|age|birthplace)(?:-|$)|個人資料|个人资料|[簡简]介|姓名|生日|年[齡龄]/u.test(
      key,
    )
  )
    return "profile";
}

function personalRecallFollowUp(prompt: string) {
  const text = visibleHarnessText(prompt).normalize("NFKC").trim();
  return (
    /^(?:那(?:[麼么])?|所以)?\s*(?:[還还](?:有(?:[沒没]有|什[麼么]|甚[麼么])?|能)?|(?:而家|咁)?仲有(?:冇|咩)?)(?:[別别]的|其他|多啲|更多)?(?:[補补]充|[嗎吗]|呢|咩|更新)?[？?!！。.]?$/u.test(
      text,
    ) || /^(?:and\s+)?(?:anything else|any updates|any additions|what else)[?!.]?$/iu.test(text)
  );
}

export function personalRecallMatches(prompt: string, precedingUserMessages: readonly string[] = []) {
  let topics = personalRecallTopics(prompt);
  if (!topics.length && personalRecallFollowUp(prompt)) {
    const anchor = precedingUserMessages.findLast((text) => !personalRecallFollowUp(text));
    if (anchor) topics = personalRecallTopics(anchor);
  }
  if (!topics.length) return;
  return (entry: Pick<MemoryEntry, "key" | "scope">) => {
    const topic = personalMemoryTopic(entry);
    return topic ? topics.indexOf(topic) : -1;
  };
}
