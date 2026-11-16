import type { BuiltinSkillSpec } from "./spec.js";

export const researchSkills: readonly BuiltinSkillSpec[] = [
  {
    id: "research-digest",
    category: "research",
    name: { en: "Research Digest", "zh-CN": "研究摘要" },
    description: {
      en: "Synthesize supplied sources into findings, evidence gaps and practical implications.",
      "zh-CN": "综合已有资料，梳理研究发现、证据缺口和实际启示。",
    },
    inputs:
      "A research question and authorized sources. State the coverage period and missing sources. Do not claim web research unless it was actually authorized and performed.",
    steps: [
      "Define the question and inclusion criteria. Inventory each supplied source with author, date, method and relevant limits where available.",
      "Extract claims with their supporting evidence and source anchors. Distinguish direct findings from commentary and your own inference.",
      "Group by finding rather than summarizing documents one after another. Explain disagreements and differences in population, time period or methods.",
      "Assess uncertainty, sample limitations and outdated evidence. Avoid counting repeated reporting of the same study as independent confirmation.",
      "Explain implications that follow from the evidence, then identify the highest-value unanswered questions and follow-up work.",
    ],
    sections: [
      "Question and scope",
      "Key findings",
      "Evidence and disagreements",
      "Limits and confidence",
      "Practical implications",
      "Open questions",
      "Source inventory",
    ],
    checks: [
      "Important claims have traceable sources.",
      "Evidence and inference are explicitly separated.",
      "No missing source is silently replaced by invented citations or findings.",
    ],
    example: {
      en: "Summarize these studies on onboarding. Compare their evidence and identify what a product team can reasonably conclude.",
      "zh-CN": "综合这些新用户引导研究，比较证据并说明产品团队能合理得出哪些结论。",
    },
  },
  {
    id: "concept-explainer",
    category: "research",
    name: { en: "Concept Explainer", "zh-CN": "概念解释卡" },
    description: {
      en: "Explain a difficult concept through a precise definition, an example and its limits.",
      "zh-CN": "通过准确的定义、例子与边界，让复杂概念容易理解。",
    },
    inputs:
      "The concept, reader's prior knowledge, learning goal and source material if accuracy depends on a particular discipline.",
    steps: [
      "State a one-sentence definition that distinguishes the concept from neighboring ideas. Expand only the prerequisites the reader needs.",
      "Explain the mechanism or reasoning in a short sequence. Keep formal definitions separate from intuition.",
      "Use one concrete example and, if useful, an analogy. Explain exactly where the analogy stops being accurate.",
      "Show a counterexample, a common misconception and a practical application. Preserve exceptions that change the reader's conclusion.",
      "Finish with two understanding-check questions and concise answers. If the concept is contested, state the competing definitions.",
    ],
    sections: [
      "One-sentence definition",
      "How it works",
      "Concrete example",
      "Limits and misconceptions",
      "Where it is useful",
      "Understanding check",
    ],
    checks: [
      "The explanation is accurate at the requested depth.",
      "An analogy is not presented as a proof.",
      "The learner can distinguish an example from a non-example.",
    ],
    example: {
      en: "Explain idempotency to a junior developer, using a payment retry example and a counterexample.",
      "zh-CN": "面向初级开发者解释幂等，用支付重试和反例帮助理解。",
    },
  },
  {
    id: "evidence-comparison",
    category: "research",
    name: { en: "Evidence-based Comparison", "zh-CN": "证据对比分析" },
    description: {
      en: "Compare options against the same criteria without inventing precision or hiding missing evidence.",
      "zh-CN": "用统一标准比较方案，明确缺失证据与不确定性。",
    },
    inputs: "Options, the user's decision context, hard constraints and the supplied evidence for each option.",
    steps: [
      "Define the decision and non-negotiable constraints before choosing evaluation criteria.",
      "Normalize comparable facts: dates, units, included features and operational assumptions. Leave non-comparable values separate.",
      "Build a comparison table with a source or uncertainty note for each material fact. Unknown is different from absent.",
      "Explain tradeoffs and scenario-dependent fit. Avoid numerical rankings unless criteria and weights are explicitly justified.",
      "Recommend a choice only to the extent the evidence supports one. Identify which missing fact could change the outcome.",
    ],
    sections: [
      "Decision context",
      "Criteria and constraints",
      "Evidence comparison",
      "Tradeoffs by scenario",
      "Recommendation and confidence",
      "Missing evidence and follow-up",
    ],
    checks: [
      "All options are compared against the same definitions.",
      "Unknown facts are not treated as negatives or zeros.",
      "The recommendation accounts for constraints and contrary evidence.",
    ],
    example: {
      en: "Compare these three document editors for an offline team using only the provided specifications.",
      "zh-CN": "仅根据提供的规格，为离线团队比较这三款文档编辑器。",
    },
  },
];
