// Shared test fixtures. Not exported from the package index.
import { memorySnapshot, type ReviewInput } from './input.js';
import type { ModelComment } from './schema.js';

export const HEAD_SHA = 'c'.repeat(40);

export const CART_TS_HEAD = `export interface Item {
  price: number;
  qty: number;
}

export function total(items: Item[]): number {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].qty;
  }
  return sum;
}

export function discount(sum: number, pct: number): number {
  return sum - sum * pct;
}
`;

export const SAMPLE_DIFF = `diff --git a/src/cart.ts b/src/cart.ts
index 1111111..2222222 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -6,7 +6,7 @@ export interface Item {
 export function total(items: Item[]): number {
   let sum = 0;
-  for (let i = 0; i < items.length; i++) {
+  for (let i = 0; i <= items.length; i++) {
     sum += items[i].price * items[i].qty;
   }
   return sum;
@@ -14,3 +14,3 @@ export function total(items: Item[]): number {
 export function discount(sum: number, pct: number): number {
-  return sum - (sum * pct) / 100;
+  return sum - sum * pct;
 }
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 3333333..4444444 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
-lockfileVersion: '9.0'
+lockfileVersion: '9.1'
`;

export function sampleInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    pr: {
      owner: 'octo',
      repo: 'shop',
      number: 12,
      title: 'Fix cart totals',
      body: 'Tidies up the loop and the discount math.',
      baseSha: 'b'.repeat(40),
      headSha: HEAD_SHA,
    },
    diff: SAMPLE_DIFF,
    head: memorySnapshot(HEAD_SHA, { 'src/cart.ts': CART_TS_HEAD }),
    ...overrides,
  };
}

export function comment(overrides: Partial<ModelComment> = {}): ModelComment {
  return {
    file: 'src/cart.ts',
    line: 8,
    category: 'bug',
    severity: 'high',
    claim: 'Loop runs one past the end: items[items.length] is undefined, so .price throws.',
    evidence: 'for (let i = 0; i <= items.length; i++) {',
    suggested_fix: 'Use `i < items.length`.',
    confidence: 0.95,
    ...overrides,
  };
}
