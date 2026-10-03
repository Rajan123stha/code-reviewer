/**
 * Bump whenever extraction output changes. It is part of every parse-cache key, so old
 * cached parses are ignored rather than mixed with new ones.
 */
export const PARSER_VERSION = 2;

export type Language = 'typescript' | 'tsx' | 'javascript';

export type SymbolKind =
  'module' | 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'variable';

/** A symbol as extracted from one file. Ids are local to the file; 0 is the module. */
export interface ParsedSymbol {
  id: number;
  name: string;
  /** Dotted name within the file, e.g. `Cart.total`. */
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Declaration head, whitespace-collapsed: everything before the body. */
  signature: string;
  exported: boolean;
  parent: number | null;
}

export interface ImportBinding {
  /** Name bound in this file. */
  local: string;
  /** Name exported by the source module: an identifier, `default`, or `*` (namespace). */
  imported: string;
  source: string;
  line: number;
}

export interface ReExport {
  /** Name this module exports, or `*` for `export * from`. */
  exported: string;
  /** Name taken from the source module, or `*`. */
  imported: string;
  source: string;
}

/** `export { local as exported }` without a source, and CommonJS `module.exports` aliases. */
export interface LocalExport {
  local: string;
  exported: string;
}

export interface CallSite {
  /** Local id of the innermost enclosing function/method/class (0 = module level). */
  from: number;
  /**
   * What is called: `name`, `this.name`, or `object.name`. Anything more complex is not
   * recorded (see ADR 0005 on static resolution limits).
   */
  callee: string;
  kind: 'call' | 'new' | 'jsx';
  line: number;
}

export interface Heritage {
  from: number;
  name: string;
  kind: 'extends' | 'implements';
}

/** Everything extracted from one file's contents. Independent of the file's path. */
export interface FileParse {
  parserVersion: number;
  language: Language;
  lineCount: number;
  symbols: ParsedSymbol[];
  imports: ImportBinding[];
  reExports: ReExport[];
  localExports: LocalExport[];
  calls: CallSite[];
  heritage: Heritage[];
  /** Call expressions the extractor saw but could not express as a CallSite. */
  skippedCalls: number;
}
