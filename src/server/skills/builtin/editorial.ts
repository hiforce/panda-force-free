import type { BuiltinSkillSpec } from "./spec.js";

export const editorialSkills: readonly BuiltinSkillSpec[] = [
  {
    id: "software-prd",
    category: "writing",
    name: { en: "Software PRD", "zh-CN": "软件需求 PRD" },
    description: {
      en: "Turn a product brief into testable requirements, explicit scope and acceptance criteria.",
      "zh-CN": "把产品需求整理为范围清晰、可验证的需求与验收标准。",
    },
    inputs:
      "A product brief, intended users, observed problem, constraints and any existing evidence. Distinguish decisions from suggestions and unanswered questions.",
    steps: [
      "Identify the user, their current task and the observable problem before proposing features. Keep unsupported impact claims as hypotheses.",
      "Separate goals, non-goals and scope boundaries. Describe the complete happy path, empty states, failures, recovery and permission boundaries.",
      "Assign stable requirement IDs. Write each requirement with a trigger, expected behavior and a measurable acceptance example; link it to the user problem.",
      "Define only justified performance, accessibility, privacy and reliability requirements. Use proposed targets when no target has been approved, and identify the decision owner.",
      "Prioritize the smallest coherent release. List dependencies, rollout, measurement and open decisions without inventing dates or commitments.",
    ],
    sections: [
      "Problem and evidence",
      "Users and scenarios",
      "Goals, non-goals and scope",
      "User journeys and interaction states",
      "Requirements and acceptance criteria",
      "Constraints and quality targets",
      "Dependencies and release plan",
      "Open questions and decision log",
    ],
    checks: [
      "Every in-scope requirement has an ID and an observable acceptance criterion.",
      "Failures and recovery are covered; unknowns are visibly separated from agreed requirements.",
      "No invented research, metrics, deadlines or stakeholder agreement.",
    ],
    example: {
      en: "Draft a PRD for a document approval flow. Include permissions, rejection, resubmission and acceptance criteria.",
      "zh-CN": "为文档审批流程编写 PRD，覆盖权限、驳回、重新提交与验收标准。",
    },
  },
  {
    id: "technical-proposal",
    category: "writing",
    name: { en: "Technical Proposal", "zh-CN": "技术方案" },
    description: {
      en: "Compare practical options and explain an implementation with clear failure and migration paths.",
      "zh-CN": "比较可行方案，说明实现、故障处理、迁移与回退路径。",
    },
    inputs:
      "The problem, current architecture, required behavior, constraints and known scale. Do not assume access to source code or infrastructure.",
    steps: [
      "State the decision and constraints, then map the current data flow and ownership using supplied evidence.",
      "Compare at least two credible options, including improving the current approach when relevant. Explain cost, complexity and operational tradeoffs rather than scoring with invented precision.",
      "Describe component responsibilities, interfaces, state transitions and data ownership. Separate authoritative data from derived indexes and caches.",
      "Trace partial failure, retry, duplicate submission, concurrency and authorization. Explain transaction boundaries, idempotency and recovery.",
      "Define staged migration, rollback, observability and validation. Label unverified capacity estimates and unresolved dependencies.",
    ],
    sections: [
      "Decision and context",
      "Constraints and current system",
      "Options and tradeoffs",
      "Proposed components and data flow",
      "Consistency and failure handling",
      "Migration and rollback",
      "Validation and observability",
      "Open decisions",
    ],
    checks: [
      "Each component has a bounded responsibility.",
      "The design explains partial failure and concurrent updates.",
      "Migration and rollback preserve existing data; diagrams agree with the prose.",
    ],
    example: {
      en: "Propose a search indexing service alongside SQLite, including consistency checks and rebuild recovery.",
      "zh-CN": "设计与 SQLite 配合的搜索索引服务，说明一致性检查和重建恢复。",
    },
  },
  {
    id: "api-contract",
    category: "writing",
    name: { en: "API Contract", "zh-CN": "API 接口规范" },
    description: {
      en: "Define requests, responses, authentication and error behavior with consistent examples.",
      "zh-CN": "明确请求、响应、认证、错误语义与一致的接口示例。",
    },
    inputs: "Resource names, operations, intended clients, authorization model and any existing API conventions.",
    steps: [
      "Identify resources, ownership and supported operations. Preserve existing naming conventions unless a change is explicitly requested.",
      "For each operation specify method, path, authentication, field types, requiredness, limits and validation. Mark proposed fields clearly.",
      "Define success and error responses, including not-found versus forbidden, conflict, rate limits and retryability. Separate transient failures from rejected input.",
      "Specify pagination, ordering, filtering, optimistic concurrency and idempotency where applicable. Describe whether retries can duplicate side effects.",
      "Write syntactically valid sample JSON that matches the contract. Include a normal call, a validation failure and a conflict or retry example where relevant.",
    ],
    sections: [
      "Purpose and conventions",
      "Authentication and authorization",
      "Resources and schemas",
      "Operations",
      "Errors and retry behavior",
      "Concurrency and idempotency",
      "Request and response examples",
      "Compatibility and open questions",
    ],
    checks: [
      "Examples use the same field names, types and status codes as the contract.",
      "No real credentials, personal data or invented production endpoints appear in samples.",
      "Mutation retry semantics and permission checks are explicit.",
    ],
    example: {
      en: "Define an API for submitting and inspecting Bot tasks, with idempotent retries and conflict examples.",
      "zh-CN": "定义助理任务提交与查询接口，包含幂等重试和冲突示例。",
    },
  },
  {
    id: "meeting-notes",
    category: "writing",
    name: { en: "Meeting Notes", "zh-CN": "会议纪要" },
    description: {
      en: "Separate decisions, action items and open questions from a meeting transcript.",
      "zh-CN": "从会议记录中提炼决定、待办与未决问题，避免混淆讨论和结论。",
    },
    inputs:
      "A transcript or notes, meeting purpose and any known participants or dates. Missing ownership and deadlines must remain unassigned.",
    steps: [
      "Read the complete supplied transcript. Identify agenda items and preserve disagreement or uncertainty instead of smoothing it away.",
      "Distinguish a proposal, a tentative preference and an agreed decision. Attribute decisions only when the record supports agreement.",
      "Extract actions with an explicit owner, deliverable, dependency and due date when stated. Use unassigned or not specified for missing fields.",
      "Group key discussion evidence under the corresponding decision or open question. Preserve useful timestamps or source anchors when provided.",
      "Produce a brief readable record and a separate action table. Flag unclear names, contradictory dates and follow-up questions.",
    ],
    sections: [
      "Meeting context",
      "Key decisions",
      "Action items: owner, deliverable and due date",
      "Discussion highlights",
      "Open questions and follow-up",
    ],
    checks: [
      "No discussion item is promoted to a decision without evidence.",
      "Each action has a deliverable; missing owners or dates are not invented.",
      "Names, dates and quantities match the source.",
    ],
    example: {
      en: "Turn this transcript into decisions and actions. Mark missing owners and deadlines explicitly.",
      "zh-CN": "将这份会议记录整理为决定与待办，明确标出缺失的负责人和截止日期。",
    },
  },
  {
    id: "decision-brief",
    category: "writing",
    name: { en: "Decision Brief", "zh-CN": "一页决策简报" },
    description: {
      en: "Make a decision easy to assess through evidence, options and a clear recommendation.",
      "zh-CN": "用证据、选项和明确建议，让决策者快速判断。",
    },
    inputs: "The decision to make, decision owner, options, evidence, constraints and the time horizon.",
    steps: [
      "Lead with the exact decision requested and the recommended next step. State confidence and major unknowns.",
      "Keep only context that materially changes the decision. Separate verified facts, estimates and assumptions.",
      "Compare credible options using shared criteria. Include the cost of delay or the current approach if relevant.",
      "Explain why the recommendation fits the constraints and what would cause it to change.",
      "End with the owner, next action, key risk and a review trigger. Aim for a one-page reading length without hiding material caveats.",
    ],
    sections: [
      "Decision requested",
      "Recommendation and confidence",
      "Context and evidence",
      "Options and tradeoffs",
      "Risks and unknowns",
      "Next action and review trigger",
    ],
    checks: [
      "The decision and next action are visible in the first paragraph.",
      "Criteria are applied consistently to all options.",
      "A key contrary fact or risk is not omitted to make the recommendation stronger.",
    ],
    example: {
      en: "Compare building and buying a search service, then draft a one-page recommendation for a small team.",
      "zh-CN": "比较搜索服务自研和采购方案，为小团队编写一页决策建议。",
    },
  },
  {
    id: "release-notes",
    category: "writing",
    name: { en: "Release Notes", "zh-CN": "版本更新说明" },
    description: {
      en: "Explain shipped changes, upgrade steps and known limitations in user-facing language.",
      "zh-CN": "用用户能理解的语言说明已交付变化、升级步骤与已知限制。",
    },
    inputs:
      "A verified change list, release version, target audience and deployment status. Source commits do not prove deployment.",
    steps: [
      "Establish the exact release scope and environment. Separate shipped changes, preview features and work still in progress.",
      "Group changes by user task or outcome. Explain the trigger and resulting behavior rather than copying commit messages.",
      "Call out breaking changes, migration, administrator steps and required configuration before optional details.",
      "Include fixed issues and known limitations without implying unverified guarantees. Mention security details only at an appropriate disclosure level.",
      "Provide a concise upgrade and verification checklist, including rollback guidance when supplied. Preserve issue references and attribution.",
    ],
    sections: [
      "Release and availability",
      "What changed",
      "Fixes",
      "Upgrade and migration",
      "Known limitations",
      "Verification and references",
    ],
    checks: [
      "Availability matches the supplied deployment evidence.",
      "Breaking changes and required user actions are easy to find.",
      "No internal discussions, credentials or unsupported performance claims leak into public copy.",
    ],
    example: {
      en: "Write customer release notes from these verified changes. Keep preview-only features separate from shipped behavior.",
      "zh-CN": "根据已核实的变更编写客户更新说明，区分已上线和预览功能。",
    },
  },
  {
    id: "longform-editor",
    category: "writing",
    name: { en: "Long-form Editor", "zh-CN": "长文结构编辑" },
    description: {
      en: "Improve an article's argument and flow while preserving its facts and the author's voice.",
      "zh-CN": "优化文章论证与阅读顺序，保留事实、限定条件和作者语气。",
    },
    inputs: "A draft, intended audience, publication context and the desired degree of editing.",
    steps: [
      "Identify the central claim, intended reader and supporting evidence. Note missing reasoning before polishing sentences.",
      "Reorder sections so each paragraph advances the argument. Remove repeated claims and unsupported generalizations.",
      "Rewrite unclear sentences with precise subjects and verbs. Preserve quotations, named entities, quantities and meaningful qualifications.",
      "Keep the author's recognizable voice. Explain material cuts or shifts in meaning; do not invent anecdotes or authority.",
      "Return a readable revised article, a short change rationale and factual questions that still require the author.",
    ],
    sections: ["Revised article", "Material structural and wording changes", "Facts or arguments to verify"],
    checks: [
      "The revised thesis remains faithful to the source.",
      "Quotations, dates and numbers have not drifted.",
      "Changes improve reasoning and readability rather than merely adding length.",
    ],
    example: {
      en: "Restructure this article for engineering leads. Keep the author's voice and identify unsupported claims.",
      "zh-CN": "面向技术负责人重组这篇文章，保留作者语气并标出缺少依据的论断。",
    },
  },
];
