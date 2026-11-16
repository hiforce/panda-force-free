// Fictional supplier facts and outcomes for documentation; no live business data.
export const publishingStages = ["materials", "theme", "copy", "review", "publish", "receipt"];
const text = (locale, en, zh) => (locale === "zh-CN" ? zh : en);
export function publishingConfig(locale) {
  return {
    name: text(locale, "Product publishing assistant", "商品发布助理"),
    code: "product-publishing",
    model: "",
    avatar: { type: "icon", icon: "sparkles", tone: "accent" },
    persona: {
      role: text(locale, "Supplier assets → verified listing", "供应商素材 → 已核验商品上架"),
      traits: text(locale, "Evidence-led; precise; asks when uncertain", "基于依据，表达准确，存疑先确认"),
      voice: text(locale, "Clear, concise and practical", "清楚、简洁、可执行"),
      motto: text(locale, "Verify the facts before publishing.", "先核实事实，再发布上架。"),
    },
    instructions: text(
      locale,
      "Work only from the current task's supplier facts and approved versions. Prepare a theme brief, supported selling points or product copy as requested. Do not invent test results, certifications, pricing or inventory. Escalate missing evidence. Select only caller-declared actions. Publishing requires an approved immutable draft; the enterprise system validates and executes it. Never select a destination yourself.",
      "仅使用当前任务的供应商事实和已审批版本，按阶段完成主题方案、卖点或商品详情。不得虚构检测、认证、价格或库存。依据缺失时提出复核。只选择调用方声明的动作；发布必须引用已审批的固定文案版本，由企业系统复核并执行。不得自行选择发布目标。",
    ),
    callbackHosts: ["jobs.enterprise.example"],
  };
}
export function publishingRequest(stage, locale = "en", productId = "ITEM-001") {
  const names = {
    materials: ["01 · Check supplier materials", "01 · 核验供应商素材包"],
    theme: ["02 · Theme brief and selling points", "02 · 制作主题方案与提炼卖点"],
    copy: ["03 · Draft product details", "03 · 编写商品详情"],
    review: ["04 · Review an unsupported claim", "04 · 复核缺少依据的表述"],
    publish: ["05 · Publish the approved revision", "05 · 自动发布已审批版本"],
    receipt: ["06 · Verify the listing receipt", "06 · 核验上架回执"],
  };
  const version = ["publish", "receipt"].includes(stage) ? "v4" : "v3";
  const facts = {
    jobId: "JOB-001",
    productId,
    sourceVersion: "materials-v1",
    draftVersion: version,
    product: text(locale, "Lightweight everyday jacket", "轻量日常外套"),
    supplierFacts: {
      fabric: text(locale, "100% polyester", "100%聚酯纤维"),
      sampleWeight: "260 g (size M)",
      pockets: 2,
      sizes: ["S", "M", "L", "XL"],
      care: text(locale, "Gentle wash at 30°C; follow the supplied care label", "30°C轻柔机洗，以提供的洗标为准"),
    },
    assets: { bundleId: "BUNDLE-001", images: ["ASSET-FRONT", "ASSET-BACK"], rightsConfirmed: true },
    ...(stage === "review" ? { unsupportedClaim: "waterproof", evidence: null, approvalRef: null } : {}),
    ...(["publish", "receipt"].includes(stage)
      ? {
          artifactRef: "DRAFT-001-v4",
          approvalRef: "APPROVAL-001",
          removedUnsupportedClaims: true,
          approvedTitle: text(locale, "Lightweight everyday jacket · two side pockets", "轻量日常外套｜双侧口袋"),
          approvedContent: {
            highlights:
              locale === "zh-CN"
                ? ["M码样衣260g", "双侧口袋", "S–XL可选"]
                : ["260 g sample in size M", "Two side pockets", "Sizes S–XL"],
            description: text(
              locale,
              "An everyday jacket made from 100% polyester with two side pockets. The size-M sample weighs 260 g; other sizes may vary. Choose from S–XL. Gentle wash at 30°C, following the supplied care label.",
              "采用100%聚酯纤维面料，配备双侧口袋。M码样衣重量260g，其他尺码可能不同。提供S–XL尺码；按洗标采用30°C轻柔机洗。",
            ),
            sourceRefs: ["materials-v1/facts", "materials-v1/care-label"],
          },
        }
      : {}),
    ...(stage === "receipt"
      ? {
          listingReceipt: {
            listingId: "LISTING-001",
            status: "published",
            sourceVersion: "v4",
            receiptRef: "RECEIPT-001",
          },
        }
      : {}),
  };
  const request = {
    title: text(locale, ...names[stage]),
    externalTaskId: `${productId.toLowerCase()}-${stage}-${version}`,
    instructions: text(
      locale,
      `Stage: ${stage}. Use only the supplied facts. Return a concise, structured result in the decision reason. Request review if evidence or approval is missing. The enterprise application orchestrates the next stage; do not skip it.`,
      `当前阶段：${stage}。仅依据所附事实，在判断结果中返回简明结构化产物。依据或审批缺失时请求复核。由企业应用编排下一阶段，不得跳步。`,
    ),
    input: { text: JSON.stringify(facts, null, 2), images: [] },
    actions: [],
  };
  if (stage !== "receipt") {
    const actionId =
      stage === "publish" ? "publish_listing" : stage === "review" ? "return_for_revision" : "save_stage";
    request.actions.push({
      id: actionId,
      label:
        stage === "publish"
          ? text(locale, "Publish approved v4", "发布已审批 v4")
          : stage === "review"
            ? text(locale, "Return draft for correction", "退回文案修订")
            : text(locale, "Store this stage's result", "保存当前阶段产物"),
      when:
        stage === "publish"
          ? text(
              locale,
              "Only when the immutable v4 artifact and approval reference match verified facts.",
              "仅当固定 v4 产物、审批单与已核验事实一致时。",
            )
          : text(
              locale,
              "Only for this task and declared stage; never change price, inventory or destination.",
              "仅用于当前任务声明阶段，不修改价格、库存或发布目标。",
            ),
      callback: {
        url: "https://jobs.enterprise.example/bot-results/accept",
        method: "POST",
        body: {
          externalTaskId: request.externalTaskId,
          productId,
          stage,
          draftVersion: version,
          ...(stage === "publish" ? { artifactRef: "DRAFT-001-v4", approvalRef: "APPROVAL-001" } : {}),
          receiptProof: "<runtime-per-job-proof>",
        },
        success: { path: "accepted", equals: true },
      },
    });
  }
  return request;
}
export function publishingOutcome(stage, locale) {
  const reasons = {
    materials: [
      "Supplier bundle BUNDLE-001 verified. Fabric, M-sample weight, pockets, sizes and care instructions are traceable. Image-use permission is recorded. No waterproof test report was supplied.",
      "已核验素材包 BUNDLE-001：面料、M码样衣重量、口袋、尺码和洗护说明均有来源，图片使用许可已记录；未提供防水检测报告。",
    ],
    theme: [
      "Theme brief: Everyday lightness. Use a dark neutral layout, a clear front view and concise facts. Selling points: 260 g M sample, two side pockets, sizes S–XL. The enterprise design service renders the approved assets.",
      "主题方案：日常轻行。使用深色中性版式、清晰正面图和简明事实。卖点：M码样衣260g、双侧口袋、S–XL可选。已审批方案由企业设计服务制作成素材。",
    ],
    copy: [
      "Draft v3 stored for review. Title: Lightweight everyday jacket · two side pockets. Detail sections cover fabric, M-sample weight, pockets, sizing and care. The unsupported waterproof wording must be removed before release.",
      "详情草稿 v3 已保存待审：标题为「轻量日常外套｜双侧口袋」，正文包含面料、M码样衣重量、口袋、尺码及洗护信息。发布前须移除缺少依据的防水表述。",
    ],
    review: [
      "Draft v3 contains a waterproof claim without a report. Return it for revision; keep the verified material facts. No publication action has been authorized for v3.",
      "文案 v3 包含无检测报告支持的防水表述，需退回修订并保留已核验素材事实；当前未授权发布 v3。",
    ],
    publish: [
      "Approved immutable artifact DRAFT-001-v4 matches APPROVAL-001 and the supplier facts. The unsupported claim has been removed. The enterprise endpoint durably accepted the publication job; final listing status requires its receipt.",
      "固定产物 DRAFT-001-v4、审批单 APPROVAL-001 与供应商事实一致，未经证实的表述已移除。企业接口已持久接收发布任务，最终是否上架以企业回执为准。",
    ],
    receipt: [
      "Enterprise receipt RECEIPT-001 confirms listing LISTING-001 is published from approved v4. The product identifier and source version match. The example workflow is complete; no further callback is required.",
      "企业回执 RECEIPT-001 确认商品 LISTING-001 已按审批版本 v4 上架，商品标识与来源版本一致。本示例流程已完成，无需再次回调。",
    ],
  };
  return text(locale, ...reasons[stage]);
}
