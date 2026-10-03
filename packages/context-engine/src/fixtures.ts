// Test fixtures; not exported from the package index.
import { gitBlobSha, type IndexSource } from './indexer.js';

export const REPO: Record<string, string> = {
  'src/money.ts': `export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export class Money {
  constructor(readonly value: number) {}

  add(other: Money): Money {
    return new Money(round(this.value + other.value));
  }
}
`,
  'src/base.ts': `export abstract class Base {
  validate(): void {
    if (!this.ok()) throw new Error('invalid');
  }
  abstract ok(): boolean;
}
`,
  'src/util/index.ts': `export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
`,
  'src/cart.ts': `import { Money, round } from './money.js';
import * as util from './util';
import { Base } from './base';
import lodash from 'lodash';

export interface Line {
  price: number;
}

export class Cart extends Base {
  private lines: Line[] = [];

  add(line: Line) {
    this.validate();
    this.lines.push(line);
  }

  total(): Money {
    return new Money(round(util.sum(this.lines.map((l) => l.price))));
  }

  ok() {
    return lodash.isArray(this.lines);
  }
}
`,
  'src/index.ts': `export * from './cart.js';
export { round as roundMoney } from './money.js';
`,
  'src/app.tsx': `import { Cart, roundMoney } from './index';

export default function App() {
  const cart = new Cart();
  return <Total value={roundMoney(cart.total().value)} />;
}

function Total(props: { value: number }) {
  return <span>{props.value}</span>;
}
`,
  'lib/legacy.js': `const { round } = require('../src/money');
const path = require('path');

function fmt(x) {
  return round(x).toFixed(2);
}

exports.helper = function () {
  return fmt(path.sep.length);
};

module.exports.fmt = fmt;
`,
  'node_modules/lodash/index.js': 'module.exports = {};\n',
  'README.md': '# not code\n',
};

export function memorySource(
  files: Record<string, string> = REPO,
): IndexSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    listFiles: async () =>
      Object.entries(files).map(([path, content]) => ({
        path,
        blobSha: gitBlobSha(content),
        size: Buffer.byteLength(content),
      })),
    readFile: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}
