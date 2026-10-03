import { createRequire } from 'node:module';
import { Language as TSLanguage, Parser, type Node } from 'web-tree-sitter';
import {
  PARSER_VERSION,
  type CallSite,
  type FileParse,
  type Heritage,
  type ImportBinding,
  type Language,
  type LocalExport,
  type ParsedSymbol,
  type ReExport,
  type SymbolKind,
} from './types.js';

const require = createRequire(import.meta.url);
const GRAMMARS: Record<Language, string> = {
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
};

const EXTENSIONS: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

/** Language for a path, or null if v1 does not index it. Declaration files are skipped. */
export function languageFor(path: string): Language | null {
  if (/\.d\.[mc]?ts$/.test(path)) return null;
  const ext = /\.[a-z]+$/.exec(path)?.[0] ?? '';
  return EXTENSIONS[ext] ?? null;
}

let parsers: Promise<Record<Language, Parser>> | undefined;

/** Load WASM grammars once per process. */
function loadParsers(): Promise<Record<Language, Parser>> {
  parsers ??= (async () => {
    await Parser.init();
    const entries = await Promise.all(
      (Object.keys(GRAMMARS) as Language[]).map(async (lang) => {
        const parser = new Parser();
        parser.setLanguage(await TSLanguage.load(require.resolve(GRAMMARS[lang])));
        return [lang, parser] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<Language, Parser>;
  })();
  return parsers;
}

const MAX_SIGNATURE = 240;

/**
 * Extract symbols, imports, exports, call sites and heritage from one file. Parsing is
 * syntactic only; nothing is resolved across files here (see graph.ts). Never executes
 * the code.
 */
export async function parseSource(content: string, language: Language): Promise<FileParse> {
  const parser = (await loadParsers())[language];
  const tree = parser.parse(content);
  if (!tree) throw new Error('tree-sitter returned no tree');
  try {
    return new Extractor(language, content).run(tree.rootNode);
  } finally {
    tree.delete();
  }
}

const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

class Extractor {
  private readonly symbols: ParsedSymbol[] = [];
  private readonly imports: ImportBinding[] = [];
  private readonly reExports: ReExport[] = [];
  private readonly localExports: LocalExport[] = [];
  private readonly calls: CallSite[] = [];
  private readonly heritage: Heritage[] = [];
  private skippedCalls = 0;
  /**
   * Depth of anonymous functions around the current node (callbacks such as
   * `test('x', () => { ... })`). Their locals are not module-level symbols even though
   * calls inside them are attributed to the enclosing named scope.
   */
  private anonymousDepth = 0;
  private readonly lineCount: number;

  constructor(
    private readonly language: Language,
    content: string,
  ) {
    this.lineCount = content.length === 0 ? 0 : content.split('\n').length;
  }

  run(root: Node): FileParse {
    this.symbols.push({
      id: 0,
      name: '<module>',
      qualifiedName: '<module>',
      kind: 'module',
      startLine: 1,
      endLine: Math.max(1, this.lineCount),
      signature: '',
      exported: false,
      parent: null,
    });
    this.visit(root, 0, false);
    return {
      parserVersion: PARSER_VERSION,
      language: this.language,
      lineCount: this.lineCount,
      symbols: this.symbols,
      imports: this.imports,
      reExports: this.reExports,
      localExports: this.localExports,
      calls: this.calls,
      heritage: this.heritage,
      skippedCalls: this.skippedCalls,
    };
  }

  private add(
    node: Node,
    name: string,
    kind: SymbolKind,
    parent: number,
    exported: boolean,
    body: Node | null,
  ) {
    const parentSym = this.symbols[parent]!;
    const qualifiedName = parentSym.kind === 'module' ? name : `${parentSym.qualifiedName}.${name}`;
    const id = this.symbols.length;
    this.symbols.push({
      id,
      name,
      qualifiedName,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: signatureOf(node, body),
      exported,
      parent,
    });
    return id;
  }

  /** Walk the tree, tracking the innermost enclosing symbol for call attribution. */
  private visit(node: Node, scope: number, exported: boolean): void {
    switch (node.type) {
      case 'export_statement':
        return this.exportStatement(node, scope);
      case 'import_statement':
        return this.importStatement(node);
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        const id = this.add(
          node,
          name,
          'function',
          scope,
          exported,
          node.childForFieldName('body'),
        );
        return this.children(node, id);
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        const id = this.add(node, name, 'class', scope, exported, node.childForFieldName('body'));
        this.classHeritage(node, id);
        return this.children(node, id);
      }
      case 'method_definition':
      case 'abstract_method_signature': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        const id = this.add(node, name, 'method', scope, false, node.childForFieldName('body'));
        return this.children(node, id);
      }
      case 'public_field_definition':
      case 'field_definition': {
        // Class fields holding functions (`handle = () => {}`) behave like methods.
        const value = node.childForFieldName('value');
        const name = (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text;
        if (name && value && FUNCTION_VALUES.has(value.type)) {
          const id = this.add(node, name, 'method', scope, false, value.childForFieldName('body'));
          return this.children(value, id);
        }
        break;
      }
      case 'interface_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (!name) break;
        const id = this.add(
          node,
          name,
          'interface',
          scope,
          exported,
          node.childForFieldName('body'),
        );
        for (const clause of node.namedChildren) {
          if (clause?.type === 'extends_type_clause') {
            for (const t of clause.namedChildren)
              if (t) this.heritage.push({ from: id, name: baseName(t), kind: 'extends' });
          }
        }
        return;
      }
      case 'type_alias_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) this.add(node, name, 'type', scope, exported, node.childForFieldName('value'));
        return;
      }
      case 'enum_declaration': {
        const name = node.childForFieldName('name')?.text;
        if (name) this.add(node, name, 'enum', scope, exported, node.childForFieldName('body'));
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        return this.variableDeclaration(node, scope, exported);
      case 'call_expression':
        this.callExpression(node, scope);
        break;
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor');
        if (ctor?.type === 'identifier') {
          this.calls.push({
            from: scope,
            callee: ctor.text,
            kind: 'new',
            line: node.startPosition.row + 1,
          });
        } else if (ctor?.type === 'member_expression') {
          const callee = memberCallee(ctor);
          if (callee)
            this.calls.push({ from: scope, callee, kind: 'new', line: node.startPosition.row + 1 });
        }
        break;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const name = node.childForFieldName('name');
        // Capitalized tags are components; lowercase ones are DOM elements.
        if (name && /^[A-Z]/.test(name.text) && /^[\w.]+$/.test(name.text)) {
          this.calls.push({
            from: scope,
            callee: name.text,
            kind: 'jsx',
            line: node.startPosition.row + 1,
          });
        }
        break;
      }
      case 'expression_statement':
        if (scope === 0 && this.anonymousDepth === 0) this.commonJsExport(node);
        break;
    }
    const anonymous = FUNCTION_VALUES.has(node.type) || node.type === 'class';
    if (anonymous) this.anonymousDepth++;
    this.children(node, scope);
    if (anonymous) this.anonymousDepth--;
  }

  private children(node: Node, scope: number) {
    for (const child of node.namedChildren) if (child) this.visit(child, scope, false);
  }

  private exportStatement(node: Node, scope: number) {
    const source = stringValue(node.childForFieldName('source'));
    const declaration = node.childForFieldName('declaration');
    const isDefault = node.children.some((c) => c?.type === 'default');

    if (declaration) {
      const before = this.symbols.length;
      this.visit(declaration, scope, true);
      if (isDefault) {
        const first = this.symbols[before];
        if (first) this.localExports.push({ local: first.name, exported: 'default' });
      }
      return;
    }

    const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
    const namespace = node.namedChildren.find((c) => c?.type === 'namespace_export');
    if (source !== null) {
      if (clause) {
        for (const spec of clause.namedChildren) {
          if (spec?.type !== 'export_specifier') continue;
          const name = spec.childForFieldName('name')?.text ?? '';
          const alias = spec.childForFieldName('alias')?.text ?? name;
          this.reExports.push({ exported: alias, imported: name, source });
        }
      } else if (namespace) {
        const alias = namespace.namedChildren.find((c) => c?.type === 'identifier')?.text;
        if (alias) this.reExports.push({ exported: alias, imported: '*', source });
      } else {
        this.reExports.push({ exported: '*', imported: '*', source });
      }
      return;
    }
    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec?.type !== 'export_specifier') continue;
        const name = spec.childForFieldName('name')?.text ?? '';
        this.localExports.push({
          local: name,
          exported: spec.childForFieldName('alias')?.text ?? name,
        });
      }
      return;
    }
    // `export default <expression>`: `export default foo` names a local symbol.
    const value = node.childForFieldName('value');
    if (isDefault && value?.type === 'identifier') {
      this.localExports.push({ local: value.text, exported: 'default' });
    } else if (isDefault && value && (FUNCTION_VALUES.has(value.type) || value.type === 'class')) {
      // Anonymous `export default function () {}` / `export default class {}`.
      const name = value.childForFieldName('name')?.text ?? 'default';
      const kind = value.type === 'class' ? 'class' : 'function';
      const id = this.add(node, name, kind, scope, true, value.childForFieldName('body'));
      this.localExports.push({ local: name, exported: 'default' });
      if (kind === 'class') this.classHeritage(value, id);
      return this.children(value, id);
    }
    if (value) this.visit(value, scope, false);
  }

  private importStatement(node: Node) {
    const source = stringValue(node.childForFieldName('source'));
    if (source === null) return;
    const line = node.startPosition.row + 1;
    const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
    if (!clause) return;
    for (const part of clause.namedChildren) {
      if (!part) continue;
      if (part.type === 'identifier') {
        this.imports.push({ local: part.text, imported: 'default', source, line });
      } else if (part.type === 'namespace_import') {
        const local = part.namedChildren.find((c) => c?.type === 'identifier')?.text;
        if (local) this.imports.push({ local, imported: '*', source, line });
      } else if (part.type === 'named_imports') {
        for (const spec of part.namedChildren) {
          if (spec?.type !== 'import_specifier') continue;
          const name = spec.childForFieldName('name')?.text ?? '';
          const alias = spec.childForFieldName('alias')?.text ?? name;
          this.imports.push({ local: alias, imported: name, source, line });
        }
      }
    }
  }

  private variableDeclaration(node: Node, scope: number, exported: boolean) {
    for (const decl of node.namedChildren) {
      if (decl?.type !== 'variable_declarator') continue;
      const nameNode = decl.childForFieldName('name');
      const value = decl.childForFieldName('value');

      // CommonJS: const x = require('./y'); const { a, b: c } = require('./y')
      const required = value ? requireSource(value) : null;
      if (required !== null && nameNode) {
        const line = decl.startPosition.row + 1;
        if (nameNode.type === 'identifier') {
          this.imports.push({ local: nameNode.text, imported: '*', source: required, line });
        } else if (nameNode.type === 'object_pattern') {
          for (const prop of nameNode.namedChildren) {
            if (prop?.type === 'shorthand_property_identifier_pattern') {
              this.imports.push({ local: prop.text, imported: prop.text, source: required, line });
            } else if (prop?.type === 'pair_pattern') {
              const key = prop.childForFieldName('key')?.text;
              const val = prop.childForFieldName('value');
              if (key && val?.type === 'identifier') {
                this.imports.push({ local: val.text, imported: key, source: required, line });
              }
            }
          }
        }
        continue;
      }

      if (nameNode?.type !== 'identifier') {
        if (value) this.visit(value, scope, false);
        continue;
      }
      if (value && FUNCTION_VALUES.has(value.type)) {
        const id = this.add(
          decl,
          nameNode.text,
          'function',
          scope,
          exported,
          value.childForFieldName('body'),
        );
        this.children(value, id);
      } else if (value && value.type === 'class') {
        const id = this.add(
          decl,
          nameNode.text,
          'class',
          scope,
          exported,
          value.childForFieldName('body'),
        );
        this.classHeritage(value, id);
        this.children(value, id);
      } else {
        // Only module-level variables are symbols; locals inside functions are not.
        const moduleLevel = scope === 0 && this.anonymousDepth === 0;
        const id = moduleLevel
          ? this.add(decl, nameNode.text, 'variable', scope, exported, value)
          : scope;
        if (value) this.visit(value, id, false);
      }
    }
  }

  private classHeritage(node: Node, id: number) {
    const heritage = node.namedChildren.find((c) => c?.type === 'class_heritage');
    if (!heritage) return;
    for (const clause of heritage.namedChildren) {
      if (!clause) continue;
      if (clause.type === 'extends_clause' || clause.type === 'implements_clause') {
        const kind = clause.type === 'extends_clause' ? 'extends' : 'implements';
        for (const t of clause.namedChildren) {
          if (t && t.type !== 'type_arguments')
            this.heritage.push({ from: id, name: baseName(t), kind });
        }
      } else {
        // JavaScript grammar: class_heritage holds the expression directly.
        this.heritage.push({ from: id, name: baseName(clause), kind: 'extends' });
      }
    }
  }

  private callExpression(node: Node, scope: number) {
    const fn = node.childForFieldName('function');
    const line = node.startPosition.row + 1;
    if (fn?.type === 'identifier') {
      if (fn.text !== 'require')
        this.calls.push({ from: scope, callee: fn.text, kind: 'call', line });
      return;
    }
    if (fn?.type === 'member_expression') {
      const callee = memberCallee(fn);
      if (callee) {
        this.calls.push({ from: scope, callee, kind: 'call', line });
        return;
      }
    }
    this.skippedCalls++;
  }

  /** `module.exports = x`, `module.exports = { a, b: c }`, `exports.x = ...`. */
  private commonJsExport(stmt: Node) {
    const expr = stmt.namedChildren[0];
    if (expr?.type !== 'assignment_expression') return;
    const left = expr.childForFieldName('left');
    const right = expr.childForFieldName('right');
    if (!left || !right) return;
    const target = left.text.replace(/\s+/g, '');
    if (target === 'module.exports') {
      if (right.type === 'identifier')
        this.localExports.push({ local: right.text, exported: 'default' });
      if (right.type === 'object') {
        for (const prop of right.namedChildren) {
          if (prop?.type === 'shorthand_property_identifier') {
            this.localExports.push({ local: prop.text, exported: prop.text });
          } else if (prop?.type === 'pair') {
            const key = prop.childForFieldName('key')?.text;
            const val = prop.childForFieldName('value');
            if (key && val?.type === 'identifier')
              this.localExports.push({ local: val.text, exported: key });
          }
        }
      }
      return;
    }
    const named = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target)?.[1];
    if (!named) return;
    if (FUNCTION_VALUES.has(right.type) || right.type === 'class') {
      const kind = right.type === 'class' ? 'class' : 'function';
      const id = this.add(stmt, named, kind, 0, true, right.childForFieldName('body'));
      this.children(right, id);
    } else if (right.type === 'identifier') {
      this.localExports.push({ local: right.text, exported: named });
    }
  }
}

/** `this.foo`, `obj.foo`; deeper chains (`a.b.c()`) are not resolvable statically here. */
function memberCallee(member: Node): string | null {
  const object = member.childForFieldName('object');
  const property = member.childForFieldName('property');
  if (!object || !property) return null;
  if (object.type === 'this') return `this.${property.text}`;
  if (object.type === 'identifier') return `${object.text}.${property.text}`;
  return null;
}

function requireSource(value: Node): string | null {
  if (value.type !== 'call_expression') return null;
  const fn = value.childForFieldName('function');
  if (fn?.type !== 'identifier' || fn.text !== 'require') return null;
  const arg = value.childForFieldName('arguments')?.namedChildren[0];
  return stringValue(arg ?? null);
}

function stringValue(node: Node | null): string | null {
  if (!node || node.type !== 'string') return null;
  return node.namedChildren.find((c) => c?.type === 'string_fragment')?.text ?? '';
}

/** `Base`, `ns.Base`, `Base<T>` all reduce to the referenced name. */
function baseName(node: Node): string {
  return node.text.replace(/<[\s\S]*$/, '').replace(/\s+/g, '');
}

/** Text from the declaration start up to its body, whitespace-collapsed. */
function signatureOf(node: Node, body: Node | null): string {
  const end = body ? body.startIndex - node.startIndex : node.text.indexOf('\n');
  const head = end > 0 ? node.text.slice(0, end) : node.text;
  const collapsed = head
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[=:]\s*$/, '')
    .trim();
  return collapsed.length > MAX_SIGNATURE ? `${collapsed.slice(0, MAX_SIGNATURE)}…` : collapsed;
}
