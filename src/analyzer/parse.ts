import ts from 'typescript';
import type {
  ComponentInfo,
  EdgeKind,
  Language,
  MemberInfo,
  ParamInfo,
  RouteFramework,
  RouteType,
  SymbolInfo,
  SymbolKind,
  TodoItem,
} from '../shared/types.js';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export interface ImportBinding {
  local: string;
  /** `default`, `*` (namespace / CommonJS module object) or the imported name. */
  imported: string;
  typeOnly: boolean;
}

export interface RawImport {
  specifier: string;
  kind: EdgeKind;
  typeOnly: boolean;
  names: string[];
  bindings: ImportBinding[];
  line: number;
}

export interface RawLocalExport {
  /** Exported name (`default` for default exports). */
  name: string;
  /** Local symbol name the export refers to. */
  local: string;
  line: number;
  typeOnly: boolean;
}

export interface RawReexport {
  specifier: string;
  star: boolean;
  names: { exported: string; imported: string }[];
  typeOnly: boolean;
  line: number;
}

export interface RawRoute {
  method: string;
  path: string;
  line: number;
  framework: RouteFramework;
  type: RouteType;
  handler?: string;
  middlewares?: string[];
  /** Identifier the route is registered on (`app`, `router`, `userRouter`…). */
  receiver?: string;
  /** For `app.use(prefix, target)`: identifiers or specifiers that may be routers from other files. */
  mountTargets?: string[];
  mountSpecifiers?: string[];
  /** Page component (identifier) for client-side routers. */
  component?: string;
  /** Lazy page component specifier for client-side routers. */
  componentSpecifier?: string;
}

/** Symbol-level facts that are resolved across files by the analyzer. */
export interface SymbolFacts {
  /** Callee expressions (`foo`, `ns.foo`, `this.foo`, `this.svc.foo`, `new:Foo`) → count. */
  calls: Map<string, number>;
  /** Type names referenced by the symbol (used for UML associations). */
  refs: Set<string>;
  /** For classes: `this.<field>` → type name. */
  fieldTypes?: Map<string, string>;
  /** For classes: the class name the facts belong to (for `this.` resolution). */
  owner?: string;
}

export interface ParsedFile {
  language: Language;
  symbols: SymbolInfo[];
  facts: Map<string, SymbolFacts>;
  imports: RawImport[];
  localExports: RawLocalExport[];
  reexports: RawReexport[];
  routes: RawRoute[];
  todos: TodoItem[];
  directives: string[];
  description?: string;
  loc: number;
  sloc: number;
  complexity: number;
  maxComplexity: number;
  isGenerated: boolean;
  usesJsx: boolean;
  commonjs: boolean;
  /** Locally declared / imported names that look like router instances. */
  parseError?: string;
}

export interface ParseOptions {
  /** Project-relative file id, used for naming anonymous default exports. */
  id: string;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const HOOK_RE = /^use[A-Z0-9]/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9_]*$/;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all']);
const SERVER_LIBS = [
  'express',
  'fastify',
  'koa',
  'koa-router',
  '@koa/router',
  'hono',
  'restify',
  'polka',
  'h3',
  'elysia',
  '@hapi/hapi',
  'connect',
  'router',
];
const ROUTER_RECEIVER_RE = /^(app|api|server|router|routes|route|r|v\d+|.*(router|app|api|server|routes))$/i;
const CLIENT_ROUTER_LIBS = [
  'react-router',
  'react-router-dom',
  'vue-router',
  '@angular/router',
  '@tanstack/react-router',
  '@tanstack/router',
  'wouter',
  '@solidjs/router',
];
const STORE_FACTORIES = new Set([
  'createSlice',
  'configureStore',
  'createStore',
  'combineReducers',
  'defineStore',
  'atom',
  'atomFamily',
  'selector',
  'selectorFamily',
  'createApi',
  'createReducer',
  'makeAutoObservable',
  'observable',
  'proxy',
  'writable',
  'readable',
  'derived',
  'createSignal',
  'createStore',
]);
const STORE_LIBS = ['zustand', 'jotai', 'recoil', 'valtio', 'mobx', 'nanostores', 'pinia', 'redux', '@reduxjs/toolkit', 'svelte/store', 'xstate'];
const COMPONENT_WRAPPERS = new Set([
  'memo',
  'forwardRef',
  'observer',
  'React.memo',
  'React.forwardRef',
  'lazy',
  'React.lazy',
  'withRouter',
  'styled',
  'defineComponent',
  'component$',
]);
const DECISION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
]);
const LOGICAL_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const NEST_HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All']);
const NEST_GQL_DECORATORS = new Set(['Query', 'Mutation', 'Subscription']);

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function toPascalCase(value: string): string {
  return value
    .replace(/\.[^.]+$/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

/** Name used for anonymous default exports: `Button.tsx` → `Button`, `user/index.ts` → `User`. */
export function defaultNameFromId(id: string): string {
  const parts = id.split('/');
  let base = parts[parts.length - 1].replace(/\.[^.]+$/, '').replace(/\.(page|layout|component|route)$/, '');
  if (['index', 'page', 'layout', 'route', 'template', '+page', '+layout'].includes(base) && parts.length > 1) {
    const parent = parts[parts.length - 2].replace(/[[\]()@.+]/g, '');
    const suffix = base === 'index' ? '' : toPascalCase(base.replace('+', ''));
    base = `${parent || 'Root'}${suffix}`;
  }
  return toPascalCase(base) || 'Default';
}

function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  if (text.endsWith('\n')) lines--;
  return lines;
}

function countSloc(text: string): number {
  let inBlock = false;
  let sloc = 0;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
      if (line) sloc++;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('<!--')) continue;
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) {
        inBlock = true;
        continue;
      }
      if (line.slice(end + 2).trim()) sloc++;
      continue;
    }
    sloc++;
  }
  return sloc;
}

const TODO_RE = /(?:\/\/|\/\*+|^\s*\*|<!--|#)\s*(TODO|FIXME|HACK|XXX|BUG)\b[\s:(\-\]]*([^\n]*)/gm;

function extractTodos(text: string): TodoItem[] {
  const todos: TodoItem[] = [];
  TODO_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TODO_RE.exec(text)) && todos.length < 200) {
    const line = countLines(text.slice(0, match.index + 1)) || 1;
    const body = match[2]
      .replace(/\*\/\s*$/, '')
      .replace(/-->\s*$/, '')
      .replace(/^\)?\s*:?\s*/, '')
      .trim();
    todos.push({ line, tag: match[1], text: clip(body || match[1], 160) });
  }
  return todos;
}

function looksGenerated(text: string): boolean {
  const head = text.slice(0, 600);
  if (/@generated|auto-?generated|do not edit|generated by/i.test(head)) return true;
  const lines = countLines(text);
  return lines > 0 && lines < 20 && text.length / lines > 400;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function nameText(name: ts.PropertyName | ts.BindingName | ts.EntityName | undefined, sf: ts.SourceFile): string {
  if (!name) return '';
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return `[${clip(name.expression.getText(sf), 40)}]`;
  if (ts.isQualifiedName(name)) return `${nameText(name.left, sf)}.${name.right.text}`;
  return clip(name.getText(sf), 60);
}

function modifiersOf(node: ts.Node): readonly ts.ModifierLike[] {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node).some((m) => m.kind === kind);
}

function decoratorsOf(node: ts.Node, sf: ts.SourceFile): { name: string; args: readonly ts.Expression[] }[] {
  const decorators = (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined) ?? [];
  return decorators.map((d) => {
    const expr = d.expression;
    if (ts.isCallExpression(expr)) return { name: clip(expr.expression.getText(sf), 40), args: expr.arguments };
    return { name: clip(expr.getText(sf), 40), args: [] };
  });
}

function visibilityOf(node: ts.Node): MemberInfo['visibility'] {
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private';
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected';
  const name = (node as { name?: ts.Node }).name;
  if (name && ts.isPrivateIdentifier(name)) return 'private';
  return undefined;
}

function walk(node: ts.Node, visit: (node: ts.Node) => boolean | void): void {
  const recurse = (child: ts.Node): void => {
    if (visit(child) === false) return;
    ts.forEachChild(child, recurse);
  };
  ts.forEachChild(node, recurse);
}

function jsDocSummary(node: ts.Node): string | undefined {
  const docs = ts.getJSDocCommentsAndTags(node);
  for (const doc of docs) {
    if (!ts.isJSDoc(doc)) continue;
    const text = ts.getTextOfJSDocComment(doc.comment);
    if (!text) continue;
    const first = text.split(/\n\s*\n/)[0];
    const sentence = first.match(/^[\s\S]*?[.!?](\s|$)/)?.[0] ?? first;
    return clip(sentence, 200);
  }
  return undefined;
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const name = expr.name.text;
    const target = expr.expression;
    if (ts.isIdentifier(target)) return `${target.text}.${name}`;
    if (target.kind === ts.SyntaxKind.ThisKeyword) return `this.${name}`;
    if (target.kind === ts.SyntaxKind.SuperKeyword) return `super.${name}`;
    if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return `this.${target.name.text}.${name}`;
    }
    return undefined;
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return calleeName(expr.expression);
  return undefined;
}

function jsxTagName(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag)) return /^[A-Z]/.test(tag.text) ? tag.text : undefined;
  if (ts.isPropertyAccessExpression(tag)) {
    const left = jsxTagName(tag.expression as ts.JsxTagNameExpression) ?? (ts.isIdentifier(tag.expression) ? tag.expression.text : undefined);
    return left ? `${left}.${tag.name.text}` : undefined;
  }
  return undefined;
}

function typeRefName(node: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments, sf: ts.SourceFile): string | undefined {
  if (ts.isTypeReferenceNode(node)) return nameText(node.typeName, sf);
  return clip(node.expression.getText(sf), 60);
}

interface BodyScan {
  complexity: number;
  calls: Map<string, number>;
  hooks: Set<string>;
  renders: Set<string>;
  contexts: Set<string>;
  refs: Set<string>;
  hasJsx: boolean;
  state: number;
}

function scanBody(node: ts.Node | undefined, sf: ts.SourceFile): BodyScan {
  const scan: BodyScan = {
    complexity: 1,
    calls: new Map(),
    hooks: new Set(),
    renders: new Set(),
    contexts: new Set(),
    refs: new Set(),
    hasJsx: false,
    state: 0,
  };
  if (!node) return scan;
  const visit = (n: ts.Node): void => {
    if (DECISION_KINDS.has(n.kind)) scan.complexity++;
    else if (ts.isBinaryExpression(n) && LOGICAL_OPERATORS.has(n.operatorToken.kind)) scan.complexity++;

    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name) {
        scan.calls.set(name, (scan.calls.get(name) ?? 0) + 1);
        const short = name.startsWith('React.') ? name.slice(6) : name;
        if (HOOK_RE.test(short) || short === 'use') {
          scan.hooks.add(short);
          if (short === 'useState' || short === 'useReducer') scan.state++;
          if ((short === 'useContext' || short === 'use') && n.arguments[0] && ts.isIdentifier(n.arguments[0])) {
            scan.contexts.add(n.arguments[0].text);
          }
        } else if (short === 'ref' || short === 'reactive' || short === 'signal' || short === 'createSignal') {
          scan.state++;
        }
        if ((short === 'createElement' || short === 'h') && n.arguments[0] && ts.isIdentifier(n.arguments[0])) {
          if (/^[A-Z]/.test(n.arguments[0].text)) scan.renders.add(n.arguments[0].text);
          scan.hasJsx = scan.hasJsx || short === 'createElement';
        }
      }
    } else if (ts.isNewExpression(n)) {
      if (ts.isIdentifier(n.expression)) {
        const key = `new:${n.expression.text}`;
        scan.calls.set(key, (scan.calls.get(key) ?? 0) + 1);
      }
    } else if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
      scan.hasJsx = true;
      const tag = jsxTagName(n.tagName);
      if (tag && tag !== 'Fragment' && tag !== 'React.Fragment') {
        scan.renders.add(tag);
        // `<Ctx.Provider>` → context usage
        if (tag.endsWith('.Provider') || tag.endsWith('.Consumer')) scan.contexts.add(tag.split('.')[0]);
      }
    } else if (ts.isJsxFragment(n)) {
      scan.hasJsx = true;
    } else if (ts.isTypeReferenceNode(n)) {
      const ref = typeRefName(n, sf);
      if (ref) scan.refs.add(ref);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return scan;
}

function addAll<T>(target: Set<T>, source: Iterable<T>): void {
  for (const item of source) target.add(item);
}

/* -------------------------------------------------------------------------- */
/*                                  Builder                                   */
/* -------------------------------------------------------------------------- */

interface PendingProps {
  symbol: SymbolInfo;
  typeName: string;
}

class ScriptAnalyzer {
  private readonly bindings = new Map<string, ImportBinding & { specifier: string }>();
  private readonly routerVars = new Set<string>();
  private readonly pendingProps: PendingProps[] = [];
  private readonly localTypeMembers = new Map<string, string[]>();
  private readonly importsServerLib: boolean;
  private readonly serverFramework: RouteFramework;
  private readonly clientRouterFramework?: RouteFramework;
  private readonly componentFramework: ComponentInfo['framework'];

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly out: ParsedFile,
    private readonly lineOffset: number,
    private readonly opts: ParseOptions & { componentFramework: ComponentInfo['framework'] },
  ) {
    const specifiers = new Set<string>();
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) specifiers.add(stmt.moduleSpecifier.text);
    }
    // CommonJS: require('express')
    if (/require\(\s*['"](express|fastify|koa|@koa\/router|koa-router|hono|restify|polka)['"]\s*\)/.test(sf.text)) {
      for (const m of sf.text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.add(m[1]);
    }
    const imported = (lib: string): boolean => [...specifiers].some((s) => s === lib || s.startsWith(`${lib}/`));
    this.importsServerLib = SERVER_LIBS.some(imported);
    this.serverFramework = imported('fastify')
      ? 'fastify'
      : imported('hono')
        ? 'hono'
        : imported('koa') || imported('@koa/router') || imported('koa-router')
          ? 'koa'
          : 'express';
    if (imported('vue-router')) this.clientRouterFramework = 'vue-router';
    else if (imported('@angular/router')) this.clientRouterFramework = 'angular';
    else if (imported('@tanstack/react-router') || imported('@tanstack/router')) this.clientRouterFramework = 'tanstack-router';
    else if (CLIENT_ROUTER_LIBS.some(imported)) this.clientRouterFramework = 'react-router';
    let framework = opts.componentFramework;
    if (framework === 'react') {
      if (imported('solid-js')) framework = 'solid';
      else if (imported('preact') || imported('preact/hooks')) framework = 'preact';
    }
    this.componentFramework = framework;
    this.storeLibImported = STORE_LIBS.some(imported);
  }

  private readonly storeLibImported: boolean;

  private line(node: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1 + this.lineOffset;
  }

  private endLine(node: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1 + this.lineOffset;
  }

  private text(node: ts.Node, max = 80): string {
    return clip(node.getText(this.sf), max);
  }

  run(): void {
    const sf = this.sf;
    // Directives such as 'use client'
    for (const stmt of sf.statements) {
      if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
        const value = stmt.expression.text;
        if (value.startsWith('use ') && value !== 'use strict' && !this.out.directives.includes(value)) {
          this.out.directives.push(value);
        }
        continue;
      }
      break;
    }

    const pendingDefaults: { local: string; line: number }[] = [];
    const pendingNamed: RawLocalExport[] = [];

    for (const stmt of sf.statements) {
      try {
        if (ts.isImportDeclaration(stmt)) this.visitImport(stmt);
        else if (ts.isExportDeclaration(stmt)) this.visitExportDeclaration(stmt, pendingNamed);
        else if (ts.isExportAssignment(stmt)) this.visitExportAssignment(stmt, pendingDefaults);
        else if (ts.isImportEqualsDeclaration(stmt)) this.visitImportEquals(stmt);
        else if (ts.isFunctionDeclaration(stmt)) this.visitFunctionDeclaration(stmt);
        else if (ts.isClassDeclaration(stmt)) this.visitClass(stmt);
        else if (ts.isInterfaceDeclaration(stmt)) this.visitInterface(stmt);
        else if (ts.isTypeAliasDeclaration(stmt)) this.visitTypeAlias(stmt);
        else if (ts.isEnumDeclaration(stmt)) this.visitEnum(stmt);
        else if (ts.isModuleDeclaration(stmt)) this.visitModule(stmt);
        else if (ts.isVariableStatement(stmt)) this.visitVariableStatement(stmt);
        else if (ts.isExpressionStatement(stmt)) this.visitExpressionStatement(stmt, pendingDefaults, pendingNamed);
      } catch {
        // A single odd statement should never break the whole file.
      }
    }

    this.walkAll();

    // Resolve pending default / named exports against local symbols.
    const byName = new Map(this.out.symbols.map((s) => [s.name, s]));
    for (const pending of pendingDefaults) {
      const symbol = byName.get(pending.local);
      if (symbol) {
        symbol.exported = true;
        symbol.isDefault = true;
      }
      this.out.localExports.push({ name: 'default', local: pending.local, line: pending.line, typeOnly: false });
    }
    for (const named of pendingNamed) {
      const symbol = byName.get(named.local);
      if (symbol) symbol.exported = true;
      const binding = this.bindings.get(named.local);
      if (!symbol && binding) {
        // `import { a } from './a'; export { a }` → behaves like a re-export.
        this.out.reexports.push({
          specifier: binding.specifier,
          star: false,
          names: [{ exported: named.name, imported: binding.imported }],
          typeOnly: named.typeOnly || binding.typeOnly,
          line: named.line,
        });
        continue;
      }
      this.out.localExports.push({ ...named, typeOnly: named.typeOnly || (symbol ? isTypeKind(symbol.kind) : false) });
    }
    for (const symbol of this.out.symbols) {
      if (symbol.exported && !pendingNamed.some((n) => n.local === symbol.name) && !pendingDefaults.some((d) => d.local === symbol.name)) {
        if (!this.out.localExports.some((e) => e.local === symbol.name)) {
          this.out.localExports.push({
            name: symbol.isDefault ? 'default' : symbol.name,
            local: symbol.name,
            line: symbol.line,
            typeOnly: isTypeKind(symbol.kind),
          });
        }
      }
    }

    // Resolve component props declared through local interfaces / type aliases.
    for (const { symbol, typeName } of this.pendingProps) {
      const members = this.localTypeMembers.get(typeName.replace(/<.*$/, ''));
      if (members && symbol.component) {
        const merged = new Set([...symbol.component.props, ...members]);
        symbol.component.props = [...merged];
      }
    }
  }

  /* ------------------------------- imports -------------------------------- */

  private addBinding(binding: ImportBinding, specifier: string): void {
    this.bindings.set(binding.local, { ...binding, specifier });
  }

  private visitImport(stmt: ts.ImportDeclaration): void {
    const specifier = stringValue(stmt.moduleSpecifier);
    if (!specifier) return;
    const clause = stmt.importClause;
    const raw: RawImport = {
      specifier,
      kind: clause ? 'import' : 'side-effect',
      typeOnly: !!clause?.isTypeOnly,
      names: [],
      bindings: [],
      line: this.line(stmt),
    };
    if (clause) {
      if (clause.name) {
        raw.names.push('default');
        raw.bindings.push({ local: clause.name.text, imported: 'default', typeOnly: clause.isTypeOnly });
      }
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        raw.names.push('*');
        raw.bindings.push({ local: nb.name.text, imported: '*', typeOnly: clause.isTypeOnly });
      } else if (nb && ts.isNamedImports(nb)) {
        let allType = nb.elements.length > 0;
        for (const el of nb.elements) {
          const imported = el.propertyName ? nameText(el.propertyName, this.sf) : el.name.text;
          const typeOnly = clause.isTypeOnly || el.isTypeOnly;
          if (!typeOnly) allType = false;
          raw.names.push(imported);
          raw.bindings.push({ local: el.name.text, imported, typeOnly });
        }
        if (allType && !clause.name) raw.typeOnly = true;
      }
    }
    for (const b of raw.bindings) this.addBinding(b, specifier);
    this.out.imports.push(raw);
  }

  private visitImportEquals(stmt: ts.ImportEqualsDeclaration): void {
    const ref = stmt.moduleReference;
    if (!ts.isExternalModuleReference(ref)) return;
    const specifier = stringValue(ref.expression);
    if (!specifier) return;
    const binding: ImportBinding = { local: stmt.name.text, imported: '*', typeOnly: stmt.isTypeOnly };
    this.addBinding(binding, specifier);
    this.out.imports.push({
      specifier,
      kind: 'require',
      typeOnly: stmt.isTypeOnly,
      names: ['*'],
      bindings: [binding],
      line: this.line(stmt),
    });
    if (hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) {
      this.out.reexports.push({
        specifier,
        star: false,
        names: [{ exported: stmt.name.text, imported: '*' }],
        typeOnly: stmt.isTypeOnly,
        line: this.line(stmt),
      });
    }
  }

  /* ------------------------------- exports -------------------------------- */

  private visitExportDeclaration(stmt: ts.ExportDeclaration, pendingNamed: RawLocalExport[]): void {
    const specifier = stringValue(stmt.moduleSpecifier);
    const line = this.line(stmt);
    const clause = stmt.exportClause;
    if (specifier) {
      if (!clause) {
        this.out.reexports.push({ specifier, star: true, names: [], typeOnly: stmt.isTypeOnly, line });
      } else if (ts.isNamespaceExport(clause)) {
        this.out.reexports.push({
          specifier,
          star: false,
          names: [{ exported: nameText(clause.name, this.sf), imported: '*' }],
          typeOnly: stmt.isTypeOnly,
          line,
        });
      } else {
        this.out.reexports.push({
          specifier,
          star: false,
          names: clause.elements.map((el) => ({
            exported: nameText(el.name, this.sf),
            imported: el.propertyName ? nameText(el.propertyName, this.sf) : nameText(el.name, this.sf),
          })),
          typeOnly: stmt.isTypeOnly || clause.elements.every((el) => el.isTypeOnly),
          line,
        });
      }
      return;
    }
    if (clause && ts.isNamedExports(clause)) {
      for (const el of clause.elements) {
        const local = el.propertyName ? nameText(el.propertyName, this.sf) : nameText(el.name, this.sf);
        pendingNamed.push({ name: nameText(el.name, this.sf), local, line, typeOnly: stmt.isTypeOnly || el.isTypeOnly });
      }
    }
  }

  private visitExportAssignment(stmt: ts.ExportAssignment, pendingDefaults: { local: string; line: number }[]): void {
    const line = this.line(stmt);
    const expr = skipWrappers(stmt.expression);
    if (ts.isIdentifier(expr)) {
      pendingDefaults.push({ local: expr.text, line });
      return;
    }
    // export default memo(Button) / connect(...)(Button) / withStyles(styles)(Button)
    const wrapped = findWrappedIdentifier(stmt.expression);
    const name = defaultNameFromId(this.opts.id);
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) {
      const fnName = (ts.isFunctionExpression(expr) || ts.isClassExpression(expr)) && expr.name ? expr.name.text : name;
      if (ts.isClassExpression(expr)) this.visitClass(expr, fnName, true);
      else this.addFunctionLike(expr, fnName, stmt, { exported: true, isDefault: true });
      pendingDefaults.push({ local: fnName, line });
      return;
    }
    if (ts.isObjectLiteralExpression(expr) && this.componentFramework === 'vue') {
      this.addVueOptionsComponent(expr, stmt);
      pendingDefaults.push({ local: this.vueComponentName(expr), line });
      return;
    }
    if (ts.isCallExpression(expr)) {
      const callee = calleeName(expr.expression);
      if (callee === 'defineComponent' || callee === 'Vue.extend' || callee === 'defineNuxtComponent') {
        const arg = expr.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          this.addVueOptionsComponent(arg, stmt);
          pendingDefaults.push({ local: this.vueComponentName(arg), line });
          return;
        }
      }
      if (wrapped) {
        pendingDefaults.push({ local: wrapped, line });
        return;
      }
      const inner = expr.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as
        | ts.ArrowFunction
        | ts.FunctionExpression
        | undefined;
      if (inner && callee && COMPONENT_WRAPPERS.has(callee)) {
        this.addFunctionLike(inner, name, stmt, { exported: true, isDefault: true, tags: [callee.replace('React.', '')] });
        pendingDefaults.push({ local: name, line });
        return;
      }
    }
    // Generic default export of an expression (config objects, instances…)
    const symbol = this.pushSymbol({
      name,
      kind: 'constant',
      line,
      endLine: this.endLine(stmt),
      exported: true,
      isDefault: true,
      loc: this.endLine(stmt) - line + 1,
      typeText: this.text(stmt.expression, 80),
    });
    this.tagFromInitializer(symbol, stmt.expression);
    pendingDefaults.push({ local: name, line });
  }

  /* ----------------------------- declarations ----------------------------- */

  private pushSymbol(partial: Omit<SymbolInfo, 'id'>): SymbolInfo {
    const symbol: SymbolInfo = { id: '', ...partial };
    this.out.symbols.push(symbol);
    return symbol;
  }

  private factsFor(key: string): SymbolFacts {
    let facts = this.out.facts.get(key);
    if (!facts) {
      facts = { calls: new Map(), refs: new Set() };
      this.out.facts.set(key, facts);
    }
    return facts;
  }

  private mergeScan(key: string, scan: BodyScan): void {
    const facts = this.factsFor(key);
    for (const [name, count] of scan.calls) facts.calls.set(name, (facts.calls.get(name) ?? 0) + count);
    addAll(facts.refs, scan.refs);
  }

  private params(list: ts.NodeArray<ts.ParameterDeclaration>): ParamInfo[] {
    return list
      .filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
      .map((p) => {
        const info: ParamInfo = { name: this.bindingText(p.name) };
        if (p.type) info.type = this.text(p.type, 60);
        if (p.questionToken || p.initializer) info.optional = true;
        if (p.initializer) info.defaultValue = this.text(p.initializer, 30);
        if (p.dotDotDotToken) info.rest = true;
        return info;
      });
  }

  private bindingText(name: ts.BindingName): string {
    if (ts.isIdentifier(name)) return name.text;
    return clip(name.getText(this.sf), 60);
  }

  private addFunctionLike(
    fn: ts.FunctionLikeDeclaration,
    name: string,
    anchor: ts.Node,
    extra: { exported?: boolean; isDefault?: boolean; tags?: string[]; propsType?: ts.TypeNode; forceComponent?: boolean } = {},
  ): SymbolInfo {
    const scan = scanBody(fn.body, this.sf);
    const isHook = HOOK_RE.test(name);
    const isComponent =
      !isHook && PASCAL_RE.test(name) && (scan.hasJsx || !!extra.forceComponent || this.componentFramework === 'solid' && scan.hasJsx);
    const kind: SymbolKind = isHook ? 'hook' : isComponent ? 'component' : 'function';
    const line = this.line(anchor);
    const endLine = this.endLine(anchor);
    const symbol = this.pushSymbol({
      name,
      kind,
      line,
      endLine,
      exported: !!extra.exported,
      isDefault: extra.isDefault || undefined,
      async: hasModifier(fn, ts.SyntaxKind.AsyncKeyword) || undefined,
      generator: !!(fn as ts.FunctionDeclaration).asteriskToken || undefined,
      params: this.params(fn.parameters),
      returnType: fn.type ? this.text(fn.type, 60) : undefined,
      complexity: scan.complexity,
      loc: endLine - line + 1,
      doc: jsDocSummary(anchor),
      tags: extra.tags?.length ? [...extra.tags] : undefined,
    });
    if (this.out.directives.includes('use server') && symbol.async) (symbol.tags ??= []).push('server-action');
    if (isComponent) {
      const props = this.propsOf(fn.parameters[0], extra.propsType, symbol);
      symbol.component = {
        framework: this.componentFramework,
        props,
        hooks: [...scan.hooks],
        renders: [...scan.renders],
        contexts: scan.contexts.size ? [...scan.contexts] : undefined,
        state: scan.state || undefined,
      };
    }
    this.mergeScan(name, scan);
    return symbol;
  }

  private propsOf(param: ts.ParameterDeclaration | undefined, hint: ts.TypeNode | undefined, symbol: SymbolInfo): string[] {
    const props = new Set<string>();
    if (param && ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) {
        const key = el.propertyName ? nameText(el.propertyName, this.sf) : nameText(el.name, this.sf);
        props.add(el.dotDotDotToken ? `...${key}` : key);
      }
    }
    const type = param?.type ?? hint;
    const collect = (t: ts.TypeNode): void => {
      if (ts.isTypeLiteralNode(t)) {
        for (const m of t.members) if (m.name) props.add(nameText(m.name, this.sf));
      } else if (ts.isTypeReferenceNode(t)) {
        const ref = nameText(t.typeName, this.sf);
        // React.FC<Props>, PropsWithChildren<Props>
        if (t.typeArguments?.length && /(PropsWithChildren|Readonly|Partial|Required)$/.test(ref)) {
          t.typeArguments.forEach(collect);
          if (ref.endsWith('PropsWithChildren')) props.add('children');
        } else {
          this.pendingProps.push({ symbol, typeName: ref });
        }
      } else if (ts.isIntersectionTypeNode(t) || ts.isUnionTypeNode(t)) {
        t.types.forEach(collect);
      } else if (ts.isParenthesizedTypeNode(t)) {
        collect(t.type);
      }
    };
    if (type) collect(type);
    return [...props];
  }

  private visitFunctionDeclaration(stmt: ts.FunctionDeclaration): void {
    if (!stmt.body && this.out.symbols.some((s) => s.name === stmt.name?.text)) return; // overload signature
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
    const name = stmt.name?.text ?? defaultNameFromId(this.opts.id);
    const existing = this.out.symbols.find((s) => s.name === name && s.kind !== 'interface' && s.kind !== 'namespace');
    if (existing && stmt.body && !existing.complexity) {
      // Replace an earlier overload signature with the implementation.
      this.out.symbols.splice(this.out.symbols.indexOf(existing), 1);
    } else if (existing) {
      return;
    }
    this.addFunctionLike(stmt, name, stmt, { exported: exported || isDefault, isDefault });
  }

  private visitClass(node: ts.ClassLikeDeclaration, forcedName?: string, forcedDefault = false): void {
    const sf = this.sf;
    const name = forcedName ?? node.name?.text ?? defaultNameFromId(this.opts.id);
    const exported = forcedDefault || hasModifier(node, ts.SyntaxKind.ExportKeyword);
    const isDefault = forcedDefault || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    const extendsList: string[] = [];
    const implementsList: string[] = [];
    for (const clause of node.heritageClauses ?? []) {
      for (const t of clause.types) {
        const ref = typeRefName(t, sf);
        if (!ref) continue;
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) extendsList.push(ref);
        else implementsList.push(ref);
      }
    }
    const decorators = decoratorsOf(node, sf);
    const members: MemberInfo[] = [];
    const facts = this.factsFor(name);
    facts.owner = name;
    facts.fieldTypes = new Map();
    let complexity = 1;
    let hasJsx = false;
    const renders = new Set<string>();
    const hooks = new Set<string>();
    let controllerPrefix: string | undefined;
    let isResolver = false;
    for (const d of decorators) {
      if (d.name === 'Controller') {
        const arg = d.args[0];
        controllerPrefix = stringValue(arg) ?? '';
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const pathProp = arg.properties.find(
            (p) => ts.isPropertyAssignment(p) && nameText(p.name, sf) === 'path',
          ) as ts.PropertyAssignment | undefined;
          controllerPrefix = stringValue(pathProp?.initializer) ?? '';
        }
      }
      if (d.name === 'Resolver') isResolver = true;
    }

    const typeNameOf = (t: ts.TypeNode | undefined): string | undefined => {
      if (!t) return undefined;
      if (ts.isTypeReferenceNode(t)) return nameText(t.typeName, sf);
      return undefined;
    };

    for (const m of node.members) {
      const line = this.line(m);
      const memberDecorators = decoratorsOf(m, sf);
      const decoratorNames = memberDecorators.length ? memberDecorators.map((d) => d.name) : undefined;
      const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword) || undefined;
      if (ts.isConstructorDeclaration(m)) {
        members.push({ name: 'constructor', kind: 'constructor', params: this.params(m.parameters), line });
        for (const p of m.parameters) {
          const isParamProperty = modifiersOf(p).some((mod) =>
            [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(mod.kind),
          );
          const typeName = typeNameOf(p.type);
          if (typeName) facts.refs.add(typeName);
          if (isParamProperty && ts.isIdentifier(p.name)) {
            members.push({
              name: p.name.text,
              kind: 'property',
              type: p.type ? this.text(p.type, 60) : undefined,
              visibility: visibilityOf(p),
              readonly: hasModifier(p, ts.SyntaxKind.ReadonlyKeyword) || undefined,
              line: this.line(p),
            });
            if (typeName) facts.fieldTypes.set(p.name.text, typeName);
          }
        }
        const scan = scanBody(m.body, sf);
        complexity += scan.complexity - 1;
        this.mergeScan(`${name}.constructor`, scan);
        this.factsFor(`${name}.constructor`).owner = name;
      } else if (ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
        const memberName = nameText(m.name, sf);
        const scan = scanBody(m.body, sf);
        complexity += scan.complexity - 1;
        hasJsx ||= scan.hasJsx;
        addAll(renders, scan.renders);
        addAll(hooks, scan.hooks);
        members.push({
          name: memberName,
          kind: ts.isMethodDeclaration(m) ? 'method' : ts.isGetAccessorDeclaration(m) ? 'getter' : 'setter',
          params: this.params(m.parameters),
          type: m.type ? this.text(m.type, 60) : undefined,
          visibility: visibilityOf(m),
          static: isStatic,
          abstract: hasModifier(m, ts.SyntaxKind.AbstractKeyword) || undefined,
          async: hasModifier(m, ts.SyntaxKind.AsyncKeyword) || undefined,
          optional: !!m.questionToken || undefined,
          decorators: decoratorNames,
          line,
        });
        const key = `${name}.${memberName}`;
        this.mergeScan(key, scan);
        this.factsFor(key).owner = name;
        // Parameter and return types are associations too (UML "uses").
        for (const p of m.parameters) if (p.type) addAll(facts.refs, scanBody(p.type, sf).refs);
        if (m.type) addAll(facts.refs, scanBody(m.type, sf).refs);
        // NestJS routes
        if (ts.isMethodDeclaration(m)) {
          for (const d of memberDecorators) {
            if (controllerPrefix !== undefined && NEST_HTTP_DECORATORS.has(d.name)) {
              const sub = stringValue(d.args[0]) ?? '';
              this.out.routes.push({
                method: d.name.toUpperCase(),
                path: joinRoute(controllerPrefix, sub),
                line,
                framework: 'nestjs',
                type: 'api',
                handler: key,
              });
            } else if (isResolver && NEST_GQL_DECORATORS.has(d.name)) {
              this.out.routes.push({
                method: d.name.toUpperCase(),
                path: memberName,
                line,
                framework: 'nestjs',
                type: 'api',
                handler: key,
              });
            }
          }
        }
      } else if (ts.isPropertyDeclaration(m)) {
        const memberName = nameText(m.name, sf);
        const init = m.initializer;
        const isFn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        let type = m.type ? this.text(m.type, 60) : undefined;
        if (!type && init && !isFn) type = `= ${this.text(init, 40)}`;
        const typeName = typeNameOf(m.type) ?? (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) ? init.expression.text : undefined);
        if (typeName) {
          facts.fieldTypes.set(memberName, typeName);
          facts.refs.add(typeName);
        }
        if (m.type) addAll(facts.refs, scanBody(m.type, sf).refs);
        members.push({
          name: memberName,
          kind: isFn ? 'method' : 'property',
          type,
          params: isFn ? this.params((init as ts.ArrowFunction).parameters) : undefined,
          visibility: visibilityOf(m),
          static: isStatic,
          readonly: hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) || undefined,
          optional: !!m.questionToken || undefined,
          abstract: hasModifier(m, ts.SyntaxKind.AbstractKeyword) || undefined,
          decorators: decoratorNames,
          line,
        });
        if (init) {
          const scan = scanBody(init, sf);
          complexity += scan.complexity - 1;
          hasJsx ||= scan.hasJsx;
          addAll(renders, scan.renders);
          const key = isFn ? `${name}.${memberName}` : name;
          this.mergeScan(key, scan);
          this.factsFor(key).owner = name;
        }
      } else if (ts.isIndexSignatureDeclaration(m)) {
        members.push({ name: `[${m.parameters.map((p) => this.text(p, 30)).join(', ')}]`, kind: 'index', type: this.text(m.type, 40), line });
      }
    }

    const reactBase = extendsList.some((e) => /^(React\.)?(Pure)?Component$/.test(e));
    const angularComponent = decorators.some((d) => d.name === 'Component');
    const isComponent = reactBase || angularComponent || (hasJsx && PASCAL_RE.test(name) && extendsList.length > 0);
    const tags = new Set<string>();
    for (const d of decorators) {
      if (d.name === 'Injectable') tags.add('injectable');
      if (d.name === 'Controller') tags.add('controller');
      if (d.name === 'Module' || d.name === 'NgModule') tags.add('module');
      if (d.name === 'Entity' || d.name === 'Schema' || d.name === 'ObjectType') tags.add('model');
      if (d.name === 'Resolver') tags.add('resolver');
      if (d.name === 'Directive') tags.add('directive');
      if (d.name === 'Pipe') tags.add('pipe');
    }
    const line = this.line(node);
    const endLine = this.endLine(node);
    const symbol = this.pushSymbol({
      name,
      kind: isComponent ? 'component' : 'class',
      line,
      endLine,
      exported,
      isDefault: isDefault || undefined,
      complexity,
      loc: endLine - line + 1,
      doc: jsDocSummary(node),
      members,
      extends: extendsList.length ? extendsList : undefined,
      implements: implementsList.length ? implementsList : undefined,
      decorators: decorators.length ? decorators.map((d) => d.name) : undefined,
      abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword) || undefined,
      tags: tags.size ? [...tags] : undefined,
    });
    if (isComponent) {
      symbol.component = {
        framework: angularComponent ? 'angular' : this.componentFramework,
        props: members.filter((m) => m.decorators?.includes('Input')).map((m) => m.name),
        hooks: [...hooks],
        renders: [...renders],
        emits: members.filter((m) => m.decorators?.includes('Output')).map((m) => m.name),
      };
    }
    for (const e of [...extendsList, ...implementsList]) facts.refs.add(e);
  }

  private typeMembers(members: ts.NodeArray<ts.TypeElement>): MemberInfo[] {
    const result: MemberInfo[] = [];
    for (const m of members) {
      const line = this.line(m);
      if (ts.isPropertySignature(m)) {
        result.push({
          name: nameText(m.name, this.sf),
          kind: 'property',
          type: m.type ? this.text(m.type, 60) : undefined,
          optional: !!m.questionToken || undefined,
          readonly: hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) || undefined,
          line,
        });
      } else if (ts.isMethodSignature(m)) {
        result.push({
          name: nameText(m.name, this.sf),
          kind: 'method',
          params: this.params(m.parameters),
          type: m.type ? this.text(m.type, 60) : undefined,
          optional: !!m.questionToken || undefined,
          line,
        });
      } else if (ts.isIndexSignatureDeclaration(m)) {
        result.push({ name: `[${m.parameters.map((p) => this.text(p, 30)).join(', ')}]`, kind: 'index', type: this.text(m.type, 40), line });
      } else if (ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) {
        result.push({ name: ts.isCallSignatureDeclaration(m) ? '()' : 'new()', kind: 'call', params: this.params(m.parameters), type: m.type ? this.text(m.type, 60) : undefined, line });
      }
    }
    return result;
  }

  private visitInterface(stmt: ts.InterfaceDeclaration): void {
    const name = stmt.name.text;
    const members = this.typeMembers(stmt.members);
    const extendsList = (stmt.heritageClauses ?? []).flatMap((c) => c.types.map((t) => typeRefName(t, this.sf) ?? '')).filter(Boolean);
    const existing = this.out.symbols.find((s) => s.name === name && s.kind === 'interface');
    this.localTypeMembers.set(name, [...(this.localTypeMembers.get(name) ?? []), ...members.map((m) => m.name)]);
    const facts = this.factsFor(name);
    addAll(facts.refs, scanBody(stmt, this.sf).refs);
    facts.refs.delete(name);
    if (existing) {
      // Declaration merging
      existing.members = [...(existing.members ?? []), ...members];
      return;
    }
    const line = this.line(stmt);
    const endLine = this.endLine(stmt);
    this.pushSymbol({
      name,
      kind: 'interface',
      line,
      endLine,
      exported: hasModifier(stmt, ts.SyntaxKind.ExportKeyword),
      isDefault: hasModifier(stmt, ts.SyntaxKind.DefaultKeyword) || undefined,
      loc: endLine - line + 1,
      doc: jsDocSummary(stmt),
      members,
      extends: extendsList.length ? extendsList : undefined,
    });
  }

  private visitTypeAlias(stmt: ts.TypeAliasDeclaration): void {
    const name = stmt.name.text;
    const line = this.line(stmt);
    const endLine = this.endLine(stmt);
    let members: MemberInfo[] | undefined;
    if (ts.isTypeLiteralNode(stmt.type)) members = this.typeMembers(stmt.type.members);
    else if (ts.isIntersectionTypeNode(stmt.type)) {
      members = stmt.type.types.filter(ts.isTypeLiteralNode).flatMap((t) => this.typeMembers(t.members));
      if (!members.length) members = undefined;
    }
    if (members) this.localTypeMembers.set(name, members.map((m) => m.name));
    const facts = this.factsFor(name);
    addAll(facts.refs, scanBody(stmt.type, this.sf).refs);
    facts.refs.delete(name);
    this.pushSymbol({
      name,
      kind: 'type',
      line,
      endLine,
      exported: hasModifier(stmt, ts.SyntaxKind.ExportKeyword),
      loc: endLine - line + 1,
      doc: jsDocSummary(stmt),
      typeText: this.text(stmt.type, 160),
      members,
    });
  }

  private visitEnum(stmt: ts.EnumDeclaration): void {
    const line = this.line(stmt);
    const endLine = this.endLine(stmt);
    this.pushSymbol({
      name: stmt.name.text,
      kind: 'enum',
      line,
      endLine,
      exported: hasModifier(stmt, ts.SyntaxKind.ExportKeyword),
      loc: endLine - line + 1,
      doc: jsDocSummary(stmt),
      members: stmt.members.map((m) => ({
        name: nameText(m.name, this.sf),
        kind: 'enumMember' as const,
        value: m.initializer ? this.text(m.initializer, 40) : undefined,
        line: this.line(m),
      })),
      tags: hasModifier(stmt, ts.SyntaxKind.ConstKeyword) ? ['const'] : undefined,
    });
  }

  private visitModule(stmt: ts.ModuleDeclaration): void {
    if (ts.isStringLiteral(stmt.name)) return; // `declare module 'x'` (ambient)
    if (stmt.flags & ts.NodeFlags.GlobalAugmentation) return;
    const name = stmt.name.text;
    if (this.out.symbols.some((s) => s.name === name)) return;
    const line = this.line(stmt);
    const endLine = this.endLine(stmt);
    this.pushSymbol({
      name,
      kind: 'namespace',
      line,
      endLine,
      exported: hasModifier(stmt, ts.SyntaxKind.ExportKeyword),
      loc: endLine - line + 1,
      doc: jsDocSummary(stmt),
    });
  }

  private visitVariableStatement(stmt: ts.VariableStatement): void {
    const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
    const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) {
        // const { a, b } = require('x') is handled in walkAll; destructured locals become variables.
        if (ts.isObjectBindingPattern(decl.name) && decl.initializer && !isRequireCall(decl.initializer)) {
          for (const el of decl.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const line = this.line(el);
            this.pushSymbol({ name: el.name.text, kind: isConst ? 'constant' : 'variable', line, endLine: line, exported, loc: 1 });
          }
        }
        continue;
      }
      const name = decl.name.text;
      const init = decl.initializer ? skipWrappers(decl.initializer) : undefined;
      if (init && isRequireCall(init)) continue; // treated as import binding
      const anchor = stmt.declarationList.declarations.length === 1 ? stmt : decl;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        const propsType = componentTypeArg(decl.type);
        this.addFunctionLike(init, name, anchor, { exported, propsType });
        continue;
      }
      if (init && ts.isClassExpression(init)) {
        this.visitClass(init, name);
        const symbol = this.out.symbols[this.out.symbols.length - 1];
        symbol.exported = exported;
        continue;
      }
      if (init && ts.isCallExpression(init)) {
        if (this.visitWrappedComponent(name, init, anchor, exported, decl.type)) continue;
      }
      if (init && ts.isTaggedTemplateExpression(init) && PASCAL_RE.test(name)) {
        const tag = this.text(init.tag, 60);
        if (/^(styled|tw|css|keyframes)\b/.test(tag)) {
          const line = this.line(anchor);
          const endLine = this.endLine(anchor);
          const inner = tag.match(/styled\(\s*([A-Z]\w*)/)?.[1];
          this.pushSymbol({
            name,
            kind: 'component',
            line,
            endLine,
            exported,
            loc: endLine - line + 1,
            doc: jsDocSummary(anchor),
            tags: ['styled'],
            typeText: tag,
            component: { framework: this.componentFramework, props: [], hooks: [], renders: inner ? [inner] : [] },
          });
          continue;
        }
      }
      const line = this.line(anchor);
      const endLine = this.endLine(anchor);
      const symbol = this.pushSymbol({
        name,
        kind: isConst ? 'constant' : 'variable',
        line,
        endLine,
        exported,
        loc: endLine - line + 1,
        doc: jsDocSummary(anchor),
        typeText: decl.type ? this.text(decl.type, 80) : init ? this.text(init, 80) : undefined,
      });
      if (init) {
        this.tagFromInitializer(symbol, init);
        const scan = scanBody(init, this.sf);
        if (scan.calls.size || scan.refs.size) this.mergeScan(name, scan);
        if (scan.complexity > 1) symbol.complexity = scan.complexity;
        const callee = ts.isCallExpression(init) || ts.isNewExpression(init) ? calleeName(init.expression) : undefined;
        if (callee && /^(express|express\.Router|Router|fastify|Fastify|Koa|Hono|KoaRouter|polka|express\.default|new:Hono|new:Koa|new:Router|new:KoaRouter)$/.test(ts.isNewExpression(init) ? `new:${callee}` : callee)) {
          this.routerVars.add(name);
        }
      }
    }
  }

  /** `const Button = memo((props) => …)`, `forwardRef(…)`, `observer(…)`, `connect(…)(Comp)`, `lazy(() => import(…))` */
  private visitWrappedComponent(
    name: string,
    init: ts.CallExpression,
    anchor: ts.Node,
    exported: boolean,
    declType?: ts.TypeNode,
  ): boolean {
    const callee = calleeName(init.expression);
    const short = callee?.replace(/^React\./, '');
    if (callee && COMPONENT_WRAPPERS.has(callee) && short !== 'lazy' && short !== 'defineComponent') {
      const inner = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as
        | ts.ArrowFunction
        | ts.FunctionExpression
        | undefined;
      if (inner) {
        const propsType = short === 'forwardRef' ? init.typeArguments?.[1] : init.typeArguments?.[0];
        this.addFunctionLike(inner, name, anchor, {
          exported,
          tags: [short ?? callee],
          propsType: propsType ?? componentTypeArg(declType),
          forceComponent: PASCAL_RE.test(name),
        });
        return true;
      }
    }
    if (short === 'defineComponent' && init.arguments[0] && ts.isObjectLiteralExpression(init.arguments[0])) {
      const symbol = this.addVueOptionsComponent(init.arguments[0], anchor, name);
      symbol.exported = exported;
      return true;
    }
    if (!PASCAL_RE.test(name)) return false;
    const line = this.line(anchor);
    const endLine = this.endLine(anchor);
    if (short === 'lazy' || callee === 'dynamic' || callee === 'defineAsyncComponent' || callee === 'loadable') {
      this.pushSymbol({
        name,
        kind: 'component',
        line,
        endLine,
        exported,
        loc: endLine - line + 1,
        tags: ['lazy'],
        component: { framework: this.componentFramework, props: [], hooks: [], renders: [] },
      });
      return true;
    }
    // Higher-order components: connect(mapState)(Comp), withStyles(styles)(Comp), withAuth(Comp)
    const wrapped = findWrappedIdentifier(init);
    if (wrapped && /^[A-Z]/.test(wrapped) && wrapped !== name) {
      this.pushSymbol({
        name,
        kind: 'component',
        line,
        endLine,
        exported,
        loc: endLine - line + 1,
        tags: ['hoc'],
        typeText: this.text(init, 80),
        component: { framework: this.componentFramework, props: [], hooks: [], renders: [wrapped] },
      });
      return true;
    }
    return false;
  }

  private vueComponentName(obj: ts.ObjectLiteralExpression): string {
    const nameProp = obj.properties.find((p) => ts.isPropertyAssignment(p) && nameText(p.name, this.sf) === 'name') as
      | ts.PropertyAssignment
      | undefined;
    return stringValue(nameProp?.initializer) ?? defaultNameFromId(this.opts.id);
  }

  /** Vue options API: `export default { name, props, components, data, methods }` */
  private addVueOptionsComponent(obj: ts.ObjectLiteralExpression, anchor: ts.Node, forcedName?: string): SymbolInfo {
    const name = forcedName ?? this.vueComponentName(obj);
    const props: string[] = [];
    const emits: string[] = [];
    const renders: string[] = [];
    for (const p of obj.properties) {
      const key = p.name ? nameText(p.name, this.sf) : '';
      if (!ts.isPropertyAssignment(p)) continue;
      if (key === 'props' || key === 'emits') {
        const target = key === 'props' ? props : emits;
        if (ts.isArrayLiteralExpression(p.initializer)) {
          for (const el of p.initializer.elements) {
            const v = stringValue(el);
            if (v) target.push(v);
          }
        } else if (ts.isObjectLiteralExpression(p.initializer)) {
          for (const prop of p.initializer.properties) if (prop.name) target.push(nameText(prop.name, this.sf));
        }
      }
      if (key === 'components' && ts.isObjectLiteralExpression(p.initializer)) {
        for (const prop of p.initializer.properties) if (prop.name) renders.push(nameText(prop.name, this.sf));
      }
    }
    const scan = scanBody(obj, this.sf);
    const line = this.line(anchor);
    const endLine = this.endLine(anchor);
    const symbol = this.pushSymbol({
      name,
      kind: 'component',
      line,
      endLine,
      exported: true,
      isDefault: forcedName ? undefined : true,
      complexity: scan.complexity,
      loc: endLine - line + 1,
      doc: jsDocSummary(anchor),
      component: { framework: 'vue', props, hooks: [...scan.hooks], renders, emits: emits.length ? emits : undefined },
    });
    this.mergeScan(name, scan);
    return symbol;
  }

  private tagFromInitializer(symbol: SymbolInfo, init: ts.Expression): void {
    const expr = skipWrappers(init);
    const call = ts.isCallExpression(expr) ? expr : undefined;
    let callee = call ? calleeName(call.expression) : ts.isNewExpression(expr) ? calleeName(expr.expression) : undefined;
    // zustand: create<State>()((set) => …)
    if (!callee && call && ts.isCallExpression(call.expression)) callee = calleeName(call.expression.expression);
    if (!callee) return;
    const short = callee.replace(/^React\./, '');
    const tags = new Set(symbol.tags ?? []);
    if (short === 'createContext') tags.add('context');
    else if (STORE_FACTORIES.has(short) || (this.storeLibImported && /^(create|createStore|defineStore|createWithEqualityFn)$/.test(short))) tags.add('store');
    else if (/^(z|yup|Joi|v)\.\w+/.test(callee) || /^(object|string|array)$/.test(short) && this.text(init, 20).startsWith('z.')) tags.add('schema');
    else if (/^(mongoose\.)?model$/.test(callee) || callee === 'new:Schema' || callee === 'mongoose.Schema' || short === 'Schema' || /^(pgTable|sqliteTable|mysqlTable)$/.test(short)) tags.add('model');
    else if (/^(express|Router|express\.Router|fastify|Fastify|Koa|Hono)$/.test(callee)) tags.add('server');
    else if (/^(createTRPCRouter|router|t\.router)$/.test(callee)) tags.add('router');
    else if (/^(axios\.create|ky\.create|createClient|new:ApolloClient|ApolloClient|QueryClient)$/.test(callee)) tags.add('client');
    else if (short === 'createAsyncThunk' || short === 'createAction') tags.add('action');
    else if (short === 'createSelector') tags.add('selector');
    else if (short === 'defineConfig') tags.add('config');
    if (tags.size) symbol.tags = [...tags];
  }

  private visitExpressionStatement(
    stmt: ts.ExpressionStatement,
    pendingDefaults: { local: string; line: number }[],
    pendingNamed: RawLocalExport[],
  ): void {
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = expr.left;
    const right = skipWrappers(expr.right);
    const leftText = left.getText(this.sf).replace(/\s+/g, '');
    const line = this.line(stmt);
    // module.exports = …
    if (leftText === 'module.exports') {
      this.out.commonjs = true;
      if (ts.isIdentifier(right)) {
        pendingDefaults.push({ local: right.text, line });
      } else if (ts.isObjectLiteralExpression(right)) {
        for (const p of right.properties) {
          if (ts.isShorthandPropertyAssignment(p)) {
            pendingNamed.push({ name: p.name.text, local: p.name.text, line, typeOnly: false });
          } else if (ts.isPropertyAssignment(p) && p.name) {
            const key = nameText(p.name, this.sf);
            const value = skipWrappers(p.initializer);
            if (ts.isIdentifier(value)) pendingNamed.push({ name: key, local: value.text, line, typeOnly: false });
            else if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
              this.addFunctionLike(value, key, p, { exported: true });
              pendingNamed.push({ name: key, local: key, line, typeOnly: false });
            }
          } else if (ts.isMethodDeclaration(p) && p.name) {
            const key = nameText(p.name, this.sf);
            this.addFunctionLike(p, key, p, { exported: true });
            pendingNamed.push({ name: key, local: key, line, typeOnly: false });
          }
        }
        pendingDefaults.push({ local: '__module_exports__', line });
      } else if (ts.isArrowFunction(right) || ts.isFunctionExpression(right)) {
        const name = ts.isFunctionExpression(right) && right.name ? right.name.text : defaultNameFromId(this.opts.id);
        this.addFunctionLike(right, name, stmt, { exported: true, isDefault: true });
        pendingDefaults.push({ local: name, line });
      } else if (ts.isClassExpression(right)) {
        const name = right.name?.text ?? defaultNameFromId(this.opts.id);
        this.visitClass(right, name, true);
        pendingDefaults.push({ local: name, line });
      } else if (ts.isNewExpression(right)) {
        // module.exports = new UserService() → a singleton instance
        const name = `${defaultNameFromId(this.opts.id).replace(/^./, (c) => c.toLowerCase())}Instance`;
        this.pushSymbol({ name, kind: 'constant', line, endLine: this.endLine(stmt), exported: true, isDefault: true, loc: 1, typeText: this.text(right, 80) });
        pendingDefaults.push({ local: name, line });
      } else {
        const wrapped = findWrappedIdentifier(right);
        if (wrapped) pendingDefaults.push({ local: wrapped, line });
        else pendingDefaults.push({ local: '__module_exports__', line });
      }
      return;
    }
    // exports.foo = … / module.exports.foo = …
    const named = leftText.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/);
    if (named) {
      this.out.commonjs = true;
      const key = named[1];
      if (ts.isIdentifier(right)) {
        pendingNamed.push({ name: key, local: right.text, line, typeOnly: false });
      } else if (ts.isArrowFunction(right) || ts.isFunctionExpression(right)) {
        this.addFunctionLike(right, key, stmt, { exported: true });
        pendingNamed.push({ name: key, local: key, line, typeOnly: false });
      } else {
        this.pushSymbol({ name: key, kind: 'constant', line, endLine: this.endLine(stmt), exported: true, loc: 1, typeText: this.text(right, 60) });
        pendingNamed.push({ name: key, local: key, line, typeOnly: false });
      }
    }
  }

  /* ------------------------------ full walk ------------------------------- */

  private walkAll(): void {
    const sf = this.sf;
    let complexity = 0;
    walk(sf, (node) => {
      if (DECISION_KINDS.has(node.kind)) complexity++;
      else if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind)) complexity++;

      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) this.out.usesJsx = true;

      if (ts.isCallExpression(node)) {
        this.visitCallForImports(node);
        this.visitCallForRoutes(node);
      } else if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === 'Route') {
        this.visitJsxRoute(node);
      } else if (ts.isObjectLiteralExpression(node) && this.clientRouterFramework) {
        this.visitObjectRoute(node);
      }
    });
    this.out.complexity += complexity + 1;
  }

  private visitCallForImports(node: ts.CallExpression): void {
    const arg = node.arguments[0];
    const specifier = stringValue(arg);
    if (!specifier) return;
    const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1;
    if (!isDynamic && !isRequire) return;
    if (isRequire) this.out.commonjs = true;
    const raw: RawImport = {
      specifier,
      kind: isDynamic ? 'dynamic' : 'require',
      typeOnly: false,
      names: [],
      bindings: [],
      line: this.line(node),
    };
    const parent = node.parent;
    if (isRequire && parent && ts.isVariableDeclaration(parent)) {
      if (ts.isIdentifier(parent.name)) {
        raw.names.push('*');
        raw.bindings.push({ local: parent.name.text, imported: '*', typeOnly: false });
      } else if (ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const imported = el.propertyName ? nameText(el.propertyName, this.sf) : el.name.text;
          raw.names.push(imported);
          raw.bindings.push({ local: el.name.text, imported, typeOnly: false });
        }
      }
    } else if (isRequire && parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      raw.names.push(parent.name.text);
      const decl = parent.parent;
      if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
        raw.bindings.push({ local: decl.name.text, imported: parent.name.text, typeOnly: false });
      }
    } else if (isDynamic) {
      raw.names.push('*');
      // const Page = lazy(() => import('./Page')) / dynamic(() => import('./Page'))
      let cursor: ts.Node | undefined = node.parent;
      for (let depth = 0; cursor && depth < 6; depth++, cursor = cursor.parent) {
        if (ts.isVariableDeclaration(cursor)) {
          if (ts.isIdentifier(cursor.name)) raw.bindings.push({ local: cursor.name.text, imported: 'default', typeOnly: false });
          break;
        }
        if (ts.isBlock(cursor) || ts.isSourceFile(cursor)) break;
      }
    } else {
      raw.names.push('*');
    }
    for (const b of raw.bindings) this.addBinding(b, specifier);
    this.out.imports.push(raw);
  }

  private isServerReceiver(receiver: ts.Expression): string | undefined {
    let name: string | undefined;
    if (ts.isIdentifier(receiver)) name = receiver.text;
    else if (ts.isPropertyAccessExpression(receiver)) name = receiver.name.text;
    if (!name) return undefined;
    if (this.routerVars.has(name)) return name;
    if (!ROUTER_RECEIVER_RE.test(name)) return undefined;
    if (this.importsServerLib || this.routerVars.size > 0 || /router|routes?$/i.test(name)) return name;
    return undefined;
  }

  private handlerText(node: ts.Expression): string {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) return this.text(node, 60);
    if (ts.isCallExpression(node)) {
      if (isRequireCall(node) || isDynamicImport(node)) return `${this.text(node.expression, 10)}('${stringValue(node.arguments[0])}')`;
      return `${this.text(node.expression, 40)}()`;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return '(inline)';
    if (ts.isArrayLiteralExpression(node)) return `[${node.elements.length}]`;
    return this.text(node, 40);
  }

  private visitCallForRoutes(node: ts.CallExpression): void {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const args = node.arguments;
    if (HTTP_METHODS.has(method)) {
      let path: string | undefined;
      let handlers: readonly ts.Expression[] = [];
      let receiver = callee.expression;
      if (args.length >= 2 && isPathLike(args[0])) {
        path = pathText(args[0], this.sf);
        handlers = args.slice(1);
      } else if (args.length >= 1) {
        // router.route('/users').get(list).post(create)
        let cursor: ts.Expression = callee.expression;
        while (ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
          if (cursor.expression.name.text === 'route' && cursor.arguments[0] && isPathLike(cursor.arguments[0])) {
            path = pathText(cursor.arguments[0], this.sf);
            receiver = cursor.expression.expression;
            break;
          }
          cursor = cursor.expression.expression;
        }
        handlers = args;
      }
      if (path === undefined || !handlers.length) return;
      const receiverName = this.isServerReceiver(receiver);
      if (!receiverName) return;
      const last = handlers[handlers.length - 1];
      this.out.routes.push({
        method: method.toUpperCase(),
        path,
        line: this.line(node),
        framework: this.serverFramework,
        type: 'api',
        handler: this.handlerText(last),
        middlewares: handlers.length > 1 ? handlers.slice(0, -1).map((h) => this.handlerText(h)) : undefined,
        receiver: receiverName,
      });
      return;
    }
    if (method === 'use' && args.length >= 1) {
      const receiverName = this.isServerReceiver(callee.expression);
      if (!receiverName) return;
      const hasPath = isPathLike(args[0]);
      const path = hasPath ? pathText(args[0], this.sf) : '/';
      const targets = hasPath ? args.slice(1) : args;
      if (!targets.length) return;
      const mountTargets: string[] = [];
      const mountSpecifiers: string[] = [];
      for (const t of targets) {
        if (ts.isIdentifier(t)) mountTargets.push(t.text);
        else if (ts.isPropertyAccessExpression(t)) mountTargets.push(this.text(t, 60));
        else if (isRequireCall(t)) mountSpecifiers.push(stringValue((t as ts.CallExpression).arguments[0])!);
      }
      if (!hasPath && !mountTargets.length && !mountSpecifiers.length) return;
      this.out.routes.push({
        method: 'USE',
        path,
        line: this.line(node),
        framework: this.serverFramework,
        type: 'middleware',
        handler: this.handlerText(targets[targets.length - 1]),
        middlewares: targets.length > 1 ? targets.slice(0, -1).map((h) => this.handlerText(h)) : undefined,
        receiver: receiverName,
        mountTargets: mountTargets.length ? mountTargets : undefined,
        mountSpecifiers: mountSpecifiers.length ? mountSpecifiers : undefined,
      });
      return;
    }
    if (method === 'route' && args.length === 1 && ts.isObjectLiteralExpression(args[0])) {
      // fastify.route({ method: 'GET', url: '/x', handler })
      const props = objectProps(args[0], this.sf);
      const url = stringValue(props.get('url')) ?? stringValue(props.get('path'));
      if (!url || !this.isServerReceiver(callee.expression)) return;
      const m = props.get('method');
      const methods = m && ts.isArrayLiteralExpression(m) ? m.elements.map((e) => stringValue(e) ?? '').filter(Boolean) : [stringValue(m) ?? 'ALL'];
      const handler = props.get('handler');
      for (const verb of methods) {
        this.out.routes.push({
          method: verb.toUpperCase(),
          path: url,
          line: this.line(node),
          framework: this.serverFramework,
          type: 'api',
          handler: handler ? this.handlerText(handler) : undefined,
        });
      }
      return;
    }
    if (method === 'register' && args.length >= 2 && ts.isObjectLiteralExpression(args[1])) {
      // fastify.register(routes, { prefix: '/v1' })
      const prefix = stringValue(objectProps(args[1], this.sf).get('prefix'));
      if (!prefix || !this.isServerReceiver(callee.expression)) return;
      const target = args[0];
      this.out.routes.push({
        method: 'USE',
        path: prefix,
        line: this.line(node),
        framework: 'fastify',
        type: 'middleware',
        handler: this.handlerText(target),
        mountTargets: ts.isIdentifier(target) ? [target.text] : undefined,
        mountSpecifiers: isRequireCall(target) || isDynamicImport(target) ? [stringValue((target as ts.CallExpression).arguments[0])!] : undefined,
      });
    }
  }

  private jsxAttr(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
    return node.attributes.properties.find((p) => ts.isJsxAttribute(p) && nameText(p.name as ts.Identifier, this.sf) === name) as
      | ts.JsxAttribute
      | undefined;
  }

  private jsxAttrString(node: ts.JsxOpeningLikeElement, name: string): string | undefined {
    const attr = this.jsxAttr(node, name);
    if (!attr) return undefined;
    if (!attr.initializer) return '';
    if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
    if (ts.isJsxExpression(attr.initializer)) return stringValue(attr.initializer.expression);
    return undefined;
  }

  private visitJsxRoute(node: ts.JsxOpeningLikeElement): void {
    const own = this.jsxAttrString(node, 'path');
    const isIndex = this.jsxAttr(node, 'index') !== undefined;
    if (own === undefined && !isIndex) return;
    // Collect parent <Route path> segments.
    const segments: string[] = [];
    let cursor: ts.Node | undefined = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent;
    while (cursor) {
      if (ts.isJsxElement(cursor) && ts.isIdentifier(cursor.openingElement.tagName) && cursor.openingElement.tagName.text === 'Route') {
        const parentPath = this.jsxAttrString(cursor.openingElement, 'path');
        if (parentPath) segments.unshift(parentPath);
      }
      cursor = cursor.parent;
    }
    const path = joinClientPath([...segments, own ?? '']);
    let component: string | undefined;
    const element = this.jsxAttr(node, 'element');
    if (element?.initializer && ts.isJsxExpression(element.initializer) && element.initializer.expression) {
      const expr = element.initializer.expression;
      if (ts.isJsxSelfClosingElement(expr)) component = jsxTagName(expr.tagName);
      else if (ts.isJsxElement(expr)) component = jsxTagName(expr.openingElement.tagName);
    }
    for (const attrName of ['component', 'Component']) {
      const attr = this.jsxAttr(node, attrName);
      if (attr?.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression && ts.isIdentifier(attr.initializer.expression)) {
        component = attr.initializer.expression.text;
      }
    }
    this.out.routes.push({
      method: 'PAGE',
      path,
      line: this.line(node),
      framework: this.clientRouterFramework ?? 'react-router',
      type: 'page',
      component,
      handler: component,
    });
  }

  private visitObjectRoute(node: ts.ObjectLiteralExpression): void {
    const props = objectProps(node, this.sf);
    const own = stringValue(props.get('path'));
    if (own === undefined) return;
    const relevant = ['component', 'element', 'Component', 'lazy', 'children', 'loadComponent', 'loadChildren', 'redirect', 'redirectTo', 'components'];
    if (!relevant.some((k) => props.has(k))) return;
    const segments: string[] = [];
    let cursor: ts.Node | undefined = node.parent;
    while (cursor) {
      if (ts.isObjectLiteralExpression(cursor)) {
        const parentPath = stringValue(objectProps(cursor, this.sf).get('path'));
        if (parentPath !== undefined) segments.unshift(parentPath);
      }
      cursor = cursor.parent;
    }
    const path = joinClientPath([...segments, own]);
    let component: string | undefined;
    let componentSpecifier: string | undefined;
    for (const key of ['component', 'Component', 'element', 'lazy', 'loadComponent']) {
      const value = props.get(key);
      if (!value) continue;
      const v = skipWrappers(value);
      if (ts.isIdentifier(v)) component = v.text;
      else if (ts.isJsxSelfClosingElement(v)) component = jsxTagName(v.tagName);
      else if (ts.isJsxElement(v)) component = jsxTagName(v.openingElement.tagName);
      else {
        walk(v, (n) => {
          if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
            componentSpecifier = stringValue(n.arguments[0]);
            return false;
          }
          return undefined;
        });
      }
      if (component || componentSpecifier) break;
    }
    const redirect = stringValue(props.get('redirect')) ?? stringValue(props.get('redirectTo'));
    this.out.routes.push({
      method: redirect ? 'REDIRECT' : 'PAGE',
      path,
      line: this.line(node),
      framework: this.clientRouterFramework!,
      type: props.has('children') && !component && !componentSpecifier ? 'layout' : 'page',
      component,
      componentSpecifier,
      handler: component ?? (componentSpecifier ? `import('${componentSpecifier}')` : redirect ? `→ ${redirect}` : undefined),
    });
  }
}

function isTypeKind(kind: SymbolKind): boolean {
  return kind === 'interface' || kind === 'type';
}

function skipWrappers(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) {
    e = e.expression;
  }
  return e;
}

function isRequireCall(expr: ts.Expression): boolean {
  const e = skipWrappers(expr);
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require' && e.arguments.length === 1 && !!stringValue(e.arguments[0]);
}

function isDynamicImport(expr: ts.Expression): boolean {
  return ts.isCallExpression(expr) && expr.expression.kind === ts.SyntaxKind.ImportKeyword;
}

/** `connect(a)(Button)` / `memo(Button)` / `withStyles(s)(Button)` → `Button` */
function findWrappedIdentifier(expr: ts.Expression): string | undefined {
  const e = skipWrappers(expr);
  if (!ts.isCallExpression(e)) return undefined;
  for (const arg of e.arguments) {
    const a = skipWrappers(arg);
    if (ts.isIdentifier(a) && /^[A-Z]/.test(a.text)) return a.text;
  }
  if (ts.isCallExpression(e.expression)) return findWrappedIdentifier(e.expression);
  return undefined;
}

function componentTypeArg(type: ts.TypeNode | undefined): ts.TypeNode | undefined {
  if (!type || !ts.isTypeReferenceNode(type)) return undefined;
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : type.typeName.right.text;
  if (/^(FC|FunctionComponent|VFC|Component|ComponentType|NextPage|ParentComponent|VoidComponent)$/.test(name)) {
    return type.typeArguments?.[0];
  }
  return undefined;
}

function isPathLike(node: ts.Expression): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.startsWith('/') || node.text === '*';
  if (ts.isTemplateExpression(node)) return node.head.text.startsWith('/') || node.head.text === '';
  if (ts.isRegularExpressionLiteral(node)) return true;
  return false;
}

function pathText(node: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return clip(node.getText(sf).replace(/^`|`$/g, ''), 80);
}

function objectProps(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): Map<string, ts.Expression> {
  const map = new Map<string, ts.Expression>();
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name) map.set(nameText(p.name, sf), p.initializer);
    else if (ts.isShorthandPropertyAssignment(p)) map.set(p.name.text, p.name);
    else if (ts.isMethodDeclaration(p) && p.name) map.set(nameText(p.name, sf), p as unknown as ts.Expression);
  }
  return map;
}

export function joinRoute(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function joinClientPath(parts: string[]): string {
  let result = '';
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('/')) result = part;
    else result = `${result.replace(/\/+$/, '')}/${part}`;
  }
  return result.replace(/\/{2,}/g, '/') || '/';
}

/* -------------------------------------------------------------------------- */
/*                                Entry points                                */
/* -------------------------------------------------------------------------- */

function emptyResult(language: Language): ParsedFile {
  return {
    language,
    symbols: [],
    facts: new Map(),
    imports: [],
    localExports: [],
    reexports: [],
    routes: [],
    todos: [],
    directives: [],
    loc: 0,
    sloc: 0,
    complexity: 0,
    maxComplexity: 0,
    isGenerated: false,
    usesJsx: false,
    commonjs: false,
  };
}

function scriptKindFor(ext: string, lang?: string): ts.ScriptKind {
  const l = (lang ?? ext).replace(/^\./, '');
  switch (l) {
    case 'ts':
    case 'mts':
    case 'cts':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'jsx':
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

export function languageFor(ext: string): Language {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.vue':
      return 'vue';
    case '.svelte':
      return 'svelte';
    case '.astro':
      return 'astro';
    default:
      return 'javascript';
  }
}

function fileDescription(text: string): string | undefined {
  const ranges = ts.getLeadingCommentRanges(text, text.startsWith('#!') ? text.indexOf('\n') + 1 : 0) ?? [];
  for (const range of ranges) {
    const raw = text.slice(range.pos, range.end);
    const body = raw
      .replace(/^\/\*\*?|\*\/$/g, '')
      .split('\n')
      .map((l) => l.replace(/^\s*(\*|\/\/)\s?/, '').trim())
      .filter((l) => l && !l.startsWith('@'))
      .join(' ')
      .trim();
    if (!body) continue;
    if (/eslint|prettier|ts-(no)?check|ts-ignore|istanbul|jshint|global |@flow|copyright|license|spdx/i.test(body)) continue;
    return clip(body, 240);
  }
  return undefined;
}

function analyzeScript(text: string, kind: ts.ScriptKind, lineOffset: number, out: ParsedFile, opts: ParseOptions, framework: ComponentInfo['framework']): void {
  const sf = ts.createSourceFile(opts.id, text, ts.ScriptTarget.Latest, true, kind);
  const analyzer = new ScriptAnalyzer(sf, out, lineOffset, { ...opts, componentFramework: framework });
  analyzer.run();
}

function finalize(out: ParsedFile, text: string): ParsedFile {
  out.loc = countLines(text);
  out.sloc = countSloc(text);
  out.todos = extractTodos(text);
  out.isGenerated = looksGenerated(text);
  out.maxComplexity = out.symbols.reduce((max, s) => Math.max(max, s.complexity ?? 0), 0);
  if (!out.complexity) out.complexity = 1;
  return out;
}

/** Parse any supported source file (JS/TS/JSX/TSX/Vue/Svelte/Astro). */
export function parseSource(id: string, text: string, ext: string): ParsedFile {
  const language = languageFor(ext);
  const out = emptyResult(language);
  const opts: ParseOptions = { id };
  try {
    if (ext === '.vue') parseVue(text, out, opts);
    else if (ext === '.svelte') parseSvelte(text, out, opts);
    else if (ext === '.astro') parseAstro(text, out, opts);
    else {
      analyzeScript(text, scriptKindFor(ext), 0, out, opts, 'react');
      out.description = fileDescription(text);
    }
  } catch (error) {
    out.parseError = error instanceof Error ? error.message : String(error);
  }
  return finalize(out, text);
}

/* --------------------------- Single-file components --------------------------- */

interface ScriptBlock {
  content: string;
  attrs: string;
  lineOffset: number;
}

function scriptBlocks(text: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const contentStart = m.index + m[0].indexOf('>') + 1;
    blocks.push({ attrs: m[1], content: m[2], lineOffset: countLines(text.slice(0, contentStart)) - 1 });
  }
  return blocks;
}

function langOf(attrs: string): string | undefined {
  return attrs.match(/\blang\s*=\s*["']([\w-]+)["']/)?.[1];
}

function kebabToPascal(tag: string): string {
  return tag
    .split(/[-.]/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

const VUE_BUILTINS = new Set(['template', 'slot', 'component', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense']);

function templateComponents(template: string, kebab: boolean): string[] {
  const found = new Set<string>();
  const re = /<([A-Za-z][\w.-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    const tag = m[1];
    if (/^[A-Z]/.test(tag)) found.add(tag);
    else if (kebab && tag.includes('-') && !VUE_BUILTINS.has(tag)) found.add(kebabToPascal(tag));
  }
  return [...found];
}

function sfcComponent(out: ParsedFile, id: string, framework: ComponentInfo['framework'], renders: string[], line: number, totalLines: number): SymbolInfo {
  let symbol = out.symbols.find((s) => s.kind === 'component' && s.isDefault);
  if (!symbol) {
    symbol = {
      id: '',
      name: defaultNameFromId(id),
      kind: 'component',
      line,
      endLine: totalLines,
      exported: true,
      isDefault: true,
      loc: totalLines,
      component: { framework, props: [], hooks: [], renders: [] },
    };
    out.symbols.unshift(symbol);
    out.localExports.push({ name: 'default', local: symbol.name, line, typeOnly: false });
  }
  symbol.component ??= { framework, props: [], hooks: [], renders: [] };
  symbol.component.framework = framework;
  symbol.component.renders = [...new Set([...symbol.component.renders, ...renders])];
  return symbol;
}

/** Collect script-setup level facts (hooks, calls, props macros) into the SFC component. */
function absorbScriptFacts(out: ParsedFile, symbol: SymbolInfo, setupText: string, kind: ts.ScriptKind, id: string, instanceScript = true): void {
  const sf = ts.createSourceFile(id, setupText, ts.ScriptTarget.Latest, true, kind);
  const props = new Set(symbol.component!.props);
  const emits = new Set(symbol.component!.emits ?? []);
  const hooks = new Set(symbol.component!.hooks);
  const facts: SymbolFacts = out.facts.get(symbol.name) ?? { calls: new Map(), refs: new Set() };
  let complexity = 1;
  const visit = (node: ts.Node): void => {
    if (DECISION_KINDS.has(node.kind)) complexity++;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name) {
        facts.calls.set(name, (facts.calls.get(name) ?? 0) + 1);
        if (HOOK_RE.test(name)) hooks.add(name);
        if (name === 'defineProps' || name === 'withDefaults' || name === 'defineEmits' || name === '$props') {
          const target = name === 'defineEmits' ? emits : props;
          const typeArg = node.typeArguments?.[0];
          if (typeArg && ts.isTypeLiteralNode(typeArg)) {
            for (const m of typeArg.members) {
              if (m.name) target.add(nameText(m.name, sf));
              else if (ts.isCallSignatureDeclaration(m) && m.parameters[0]?.type && ts.isLiteralTypeNode(m.parameters[0].type)) {
                const lit = m.parameters[0].type.literal;
                if (ts.isStringLiteral(lit)) target.add(lit.text);
              }
            }
          }
          const arg = node.arguments[0];
          if (arg && ts.isArrayLiteralExpression(arg)) arg.elements.forEach((e) => stringValue(e) && target.add(stringValue(e)!));
          else if (arg && ts.isObjectLiteralExpression(arg) && name !== 'withDefaults') {
            arg.properties.forEach((p) => p.name && target.add(nameText(p.name, sf)));
          }
          // Svelte 5: let { a, b } = $props()
          if (name === '$props' && ts.isVariableDeclaration(node.parent) && ts.isObjectBindingPattern(node.parent.name)) {
            for (const el of node.parent.name.elements) props.add(nameText(el.propertyName ?? el.name, sf));
          }
        }
      }
    }
    // Svelte 4: export let name (instance script only; `export const` is not a prop)
    if (
      instanceScript &&
      ts.isVariableStatement(node) &&
      hasModifier(node, ts.SyntaxKind.ExportKeyword) &&
      (node.declarationList.flags & ts.NodeFlags.Const) === 0 &&
      symbol.component!.framework === 'svelte'
    ) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) props.add(d.name.text);
    }
    // Astro: const { a } = Astro.props
    if (ts.isVariableDeclaration(node) && node.initializer && node.initializer.getText(sf) === 'Astro.props' && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) props.add(nameText(el.propertyName ?? el.name, sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  out.facts.set(symbol.name, facts);
  symbol.component!.props = [...props];
  symbol.component!.hooks = [...hooks];
  if (emits.size) symbol.component!.emits = [...emits];
  symbol.complexity = Math.max(symbol.complexity ?? 1, complexity);
}

function parseVue(text: string, out: ParsedFile, opts: ParseOptions): void {
  const blocks = scriptBlocks(text);
  for (const block of blocks) {
    const kind = scriptKindFor('.js', langOf(block.attrs) ?? 'js');
    analyzeScript(block.content, kind, block.lineOffset, out, opts, 'vue');
  }
  // Remove script setup locals that were mistaken for exports; keep their symbols though.
  const templateMatch = text.match(/<template\b[^>]*>([\s\S]*)<\/template>/i);
  const renders = templateMatch ? templateComponents(templateMatch[1], true) : [];
  const setup = blocks.find((b) => /\bsetup\b/.test(b.attrs));
  const symbol = sfcComponent(out, opts.id, 'vue', renders, setup ? setup.lineOffset + 1 : 1, countLines(text));
  for (const block of blocks) absorbScriptFacts(out, symbol, block.content, scriptKindFor('.js', langOf(block.attrs) ?? 'ts'), opts.id);
  out.description = blocks[0] ? fileDescription(blocks[0].content) : undefined;
}

function parseSvelte(text: string, out: ParsedFile, opts: ParseOptions): void {
  const blocks = scriptBlocks(text);
  for (const block of blocks) {
    analyzeScript(block.content, scriptKindFor('.js', langOf(block.attrs) ?? 'js'), block.lineOffset, out, opts, 'svelte');
  }
  // Svelte `export let` are props, not module exports.
  if (blocks.some((b) => !/context\s*=\s*["']module["']/.test(b.attrs))) {
    const instance = blocks.find((b) => !/context\s*=\s*["']module["']/.test(b.attrs));
    if (instance) {
      const exportedLets = new Set([...instance.content.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
      out.localExports = out.localExports.filter((e) => !exportedLets.has(e.local));
      out.symbols = out.symbols.filter((s) => !exportedLets.has(s.name));
    }
  }
  const markup = text.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const symbol = sfcComponent(out, opts.id, 'svelte', templateComponents(markup, false), 1, countLines(text));
  for (const block of blocks) {
    const isModule = /context\s*=\s*["']module["']|\bmodule\b/.test(block.attrs);
    absorbScriptFacts(out, symbol, block.content, scriptKindFor('.js', langOf(block.attrs) ?? 'ts'), opts.id, !isModule);
  }
  out.description = blocks[0] ? fileDescription(blocks[0].content) : undefined;
}

function parseAstro(text: string, out: ParsedFile, opts: ParseOptions): void {
  const fm = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  let markup = text;
  if (fm) {
    const offset = countLines(text.slice(0, (fm.index ?? 0) + fm[0].indexOf('\n') + 1)) - 1;
    analyzeScript(fm[1], ts.ScriptKind.TS, offset, out, opts, 'astro');
    markup = text.slice((fm.index ?? 0) + fm[0].length);
  }
  for (const block of scriptBlocks(markup)) {
    // Client-side <script> tags in Astro run in the browser; analyze their imports too.
    analyzeScript(block.content, ts.ScriptKind.TS, block.lineOffset, out, opts, 'astro');
  }
  const cleaned = markup.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const symbol = sfcComponent(out, opts.id, 'astro', templateComponents(cleaned, false), 1, countLines(text));
  if (fm) absorbScriptFacts(out, symbol, fm[1], ts.ScriptKind.TS, opts.id);
  out.description = fm ? fileDescription(fm[1]) : undefined;
}
