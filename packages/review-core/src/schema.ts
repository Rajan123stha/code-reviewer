import { z } from 'zod';

export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'error-handling',
  'concurrency',
  'api-misuse',
  'maintainability',
  'testing',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Structured output requested from the model. The name is part of the LLM cache key and is
 * stored with each review: bump the version whenever the shape or field meaning changes.
 */
export const REVIEW_SCHEMA_NAME = 'review-comments/v1';

export const modelCommentSchema = z.object({
  file: z.string().describe('Path of the file, exactly as in the diff header'),
  line: z.number().int().describe('New-file line number from an R<number> label in that diff'),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  claim: z.string().describe('The problem and its consequence, in one or two sentences'),
  evidence: z
    .string()
    .describe('Code quoted verbatim from the diff or file that shows the problem'),
  suggested_fix: z.string().nullable().describe('Concrete fix, or null'),
  confidence: z.number().describe('Probability from 0 to 1 that the comment is correct and useful'),
});

export const reviewOutputSchema = z.object({
  comments: z.array(modelCommentSchema),
});

export type ModelComment = z.infer<typeof modelCommentSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
