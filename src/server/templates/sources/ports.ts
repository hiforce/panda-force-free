import type { CapturedSourceReader, CapturedSourceConsumer } from "../../../shared/packages/ownership.js";

/** Intake callers consume neutral capture ports under the established source runtime allocation. */
export type TemplateSourceReader = CapturedSourceReader;
export type TemplateSourceConsumer = CapturedSourceConsumer;
