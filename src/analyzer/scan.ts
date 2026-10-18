/**
 * One pass over a script's syntax tree that collects what developers keep asking about: which
 * environment variables the code reads, which risky patterns it contains and how often it switches
 * the type checker off. The results ride along in the cached parse result.
 *
 * It looks at syntax only (no type information), so every rule is written to be precise rather than
 * broad: a finding should be worth a developer's time.
 */
import ts from 'typescript';
import { CREDENTIAL_NAME_RE, findSecret, looksLikeCredentialValue, maskSecret, maskSecretsIn } from '../shared/risks.js';
import type { EnvAccess, EnvRead, RawRisk, TypeEscapes } from '../shared/types.js';

/** What one script block contributes to `ParsedFile`. */
export interface ScriptScan {
  env: EnvRead[];
  risks: RawRisk[];
  escapes: TypeEscapes;
}

const MAX_ENV_READS = 200;
const MAX_RISKS = 50;
const SNIPPET_LENGTH = 160;
/** Strings shorter than this cannot hold any of the secret formats. */
const MIN_SECRET_LENGTH = 12;
/** Only the start of a long literal is checked for secrets (a private key announces itself at the top). */
const SECRET_SCAN_LENGTH = 4000;

export const emptyEscapes = (): TypeEscapes => ({ any: 0, nonNull: 0, tsIgnore: 0, tsExpectError: 0, lintDisable: 0 });

export const hasEscapes = (e: TypeEscapes): boolean => e.any + e.nonNull + e.tsIgnore + e.tsExpectError + e.lintDisable > 0;

export function addEscapes(into: TypeEscapes, add: TypeEscapes): void {
  into.any += add.any;
  into.nonNull += add.nonNull;
  into.tsIgnore += add.tsIgnore;
  into.tsExpectError += add.tsExpectError;
  into.lintDisable += add.lintDisable;
}

const TS_DIRECTIVE_RE = /(?:\/\/|\/\*)\s*@ts-(ignore|expect-error|nocheck)\b/g;
const LINT_DISABLE_RE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b/g;

const SQL_RE = /\b(?:select\b[^]*\bfrom|insert\s+into|update\b[^]*\bset|delete\s+from|drop\s+(?:table|database))\b/i;
const SQL_METHODS = new Set(['query', 'execute', 'raw', 'queryRaw', 'executeRaw', 'run', 'all', 'get']);
const UNSAFE_SQL_METHODS = new Set(['$queryRawUnsafe', '$executeRawUnsafe']);
const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML']);
const ANGULAR_BYPASS = /^bypassSecurityTrust(Html|Script|Url|ResourceUrl|Style)$/;
/** Calls that only convert a value: `Number(process.env.PORT) || 3000` still has a default. */
const CONVERTERS = new Set(['Number', 'parseInt', 'parseFloat', 'String', 'Boolean']);
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** `process.env`, `import.meta.env`, `Bun.env` or `Deno.env` as an object expression. */
function envObject(node: ts.Expression): EnvAccess | undefined {
  const e = unwrap(node);
  if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'env') return undefined;
  const owner = unwrap(e.expression);
  if (ts.isIdentifier(owner)) {
    if (owner.text === 'process') return 'process.env';
    if (owner.text === 'Bun') return 'Bun.env';
    if (owner.text === 'Deno') return 'Deno.env';
  }
  if (ts.isMetaProperty(owner) && owner.keywordToken === ts.SyntaxKind.ImportKeyword) return 'import.meta.env';
  return undefined;
}

/** The text a string or template expression spells out, with `\0` standing in for every dynamic part. */
function staticText(node: ts.Expression): { text: string; dynamic: boolean } {
  const e = unwrap(node);
  if (ts.isStringLiteralLike(e)) return { text: e.text, dynamic: false };
  if (ts.isTemplateExpression(e)) return { text: e.head.text + e.templateSpans.map((s) => `\0${s.literal.text}`).join(''), dynamic: true };
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(e.left);
    const right = staticText(e.right);
    return { text: left.text + right.text, dynamic: left.dynamic || right.dynamic };
  }
  return { text: '\0', dynamic: true };
}

/** The value is built at runtime (a variable, a call, a template with substitutions), not spelled out. */
const isDynamic = (node: ts.Expression): boolean => staticText(node).dynamic;

/** The name of a property, variable or assignment target (`config.password`, `password`, `'password'`). */
function targetName(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) return name.name.text;
  return undefined;
}

/** Names that `child_process` is available under: `exec` directly, or a namespace such as `cp`. */
function childProcessBindings(sf: ts.SourceFile): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  const isExec = (n: string): boolean => n === 'exec' || n === 'execSync';
  const requireOf = (e: ts.Expression | undefined): boolean => {
    const call = e && unwrap(e);
    return !!call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'require' && !!call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) && CHILD_PROCESS.has(call.arguments[0].text);
  };
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteralLike(stmt.moduleSpecifier) && CHILD_PROCESS.has(stmt.moduleSpecifier.text)) {
      const bindings = stmt.importClause?.namedBindings;
      if (stmt.importClause?.name) namespaces.add(stmt.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) if (isExec((el.propertyName ?? el.name).text)) direct.add(el.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!requireOf(d.initializer)) continue;
        if (ts.isIdentifier(d.name)) namespaces.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name)) for (const el of d.name.elements) if (ts.isIdentifier(el.name) && isExec((el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text)) direct.add(el.name.text);
      }
    }
  }
  return { direct, namespaces };
}

/** Collects findings for one source file. `lineOffset` is the number of lines before an embedded script. */
export function scanScript(sf: ts.SourceFile, lineOffset = 0): ScriptScan {
  const env: EnvRead[] = [];
  const risks: RawRisk[] = [];
  const escapes = emptyEscapes();
  const lineStarts = sf.getLineStarts();
  const cp = childProcessBindings(sf);

  const lineOf = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  const snippetOf = (node: ts.Node): string => {
    const line = lineOf(node);
    // Masked before it is cut, so a cut can never leave half of a secret behind.
    const text = maskSecretsIn(sf.text.slice(lineStarts[line], lineStarts[line + 1] ?? sf.text.length).trim());
    return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH - 1)}…` : text;
  };
  const risk = (rule: RawRisk['rule'], node: ts.Node, detail?: string): void => {
    if (risks.length >= MAX_RISKS) return;
    const line = lineOf(node) + 1 + lineOffset;
    // One finding per rule and line: a call and the literal inside it are the same problem.
    if (risks.some((r) => r.rule === rule && r.line === line)) return;
    risks.push({ rule, line, snippet: snippetOf(node), ...(detail ? { detail } : {}) });
  };
  const read = (name: string, node: ts.Node, access: EnvAccess, fallback: boolean): void => {
    if (env.length < MAX_ENV_READS) env.push({ name, line: lineOf(node) + 1 + lineOffset, access, ...(fallback ? { fallback } : {}) });
  };

  /** The read has a default when `||` or `??` follows it, possibly behind `Number(...)`. */
  const hasFallback = (node: ts.Node): boolean => {
    let child: ts.Node = node;
    let parent = node.parent;
    while (parent) {
      if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
        child = parent;
        parent = parent.parent;
      } else if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && CONVERTERS.has(parent.expression.text) && parent.arguments[0] === child) {
        child = parent;
        parent = parent.parent;
      } else break;
    }
    return !!parent && ts.isBinaryExpression(parent) && parent.left === child && (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken);
  };
  const isWrite = (node: ts.Node): boolean => {
    const parent = node.parent;
    return (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) || ts.isDeleteExpression(parent);
  };

  const checkSecretLiteral = (node: ts.StringLiteralLike): void => {
    if (node.text.length < MIN_SECRET_LENGTH) return;
    const found = findSecret(node.text.slice(0, SECRET_SCAN_LENGTH));
    if (found) risk('hardcoded-secret', node, `${found.label} ${maskSecret(found.secret)}`);
  };

  const checkCredentialAssignment = (name: ts.Node, value: ts.Expression | undefined, node: ts.Node): void => {
    const target = targetName(name);
    const literal = value && unwrap(value);
    if (!target || !literal || !ts.isStringLiteralLike(literal) || !CREDENTIAL_NAME_RE.test(target)) return;
    if (findSecret(literal.text) || !looksLikeCredentialValue(literal.text)) return;
    risk('hardcoded-credential', node, `${target} = ${maskSecret(literal.text)}`);
  };

  const checkCall = (node: ts.CallExpression): void => {
    const callee = unwrap(node.expression);
    const [first, second] = node.arguments;
    // Deno.env.get('NAME')
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'get' && envObject(callee.expression) === 'Deno.env' && first && ts.isStringLiteralLike(first)) read(first.text, node, 'Deno.env', false);

    if (ts.isIdentifier(callee) && callee.text === 'eval' && first && isDynamic(first)) risk('eval', node);
    if (ts.isIdentifier(callee) && (callee.text === 'setTimeout' || callee.text === 'setInterval') && first && ts.isStringLiteralLike(unwrap(first))) risk('eval', node, `${callee.text} with a string`);

    const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
    if (method === 'insertAdjacentHTML' && second && isDynamic(second)) risk('html-injection', node);
    if ((method === 'write' || method === 'writeln') && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'document' && first && isDynamic(first)) risk('html-injection', node);
    if (method && ANGULAR_BYPASS.test(method)) risk('html-injection', node, method);

    const isExec =
      (ts.isIdentifier(callee) && cp.direct.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && cp.namespaces.has(callee.expression.text) && (method === 'exec' || method === 'execSync'));
    if (isExec && first && staticText(first).dynamic) risk('shell-injection', node);

    if (method && first) {
      if (UNSAFE_SQL_METHODS.has(method) && isDynamic(first)) risk('sql-injection', node, method);
      else if (SQL_METHODS.has(method)) {
        const sql = staticText(first);
        if (sql.dynamic && SQL_RE.test(sql.text)) risk('sql-injection', node);
      }
    }
  };

  const checkAssignment = (node: ts.BinaryExpression): void => {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = unwrap(node.left);
    if (ts.isPropertyAccessExpression(left) && HTML_PROPERTIES.has(left.name.text) && isDynamic(node.right)) risk('html-injection', node, left.name.text);
    if (ts.isPropertyAccessExpression(left) && envObject(left.expression) === 'process.env' && left.name.text === 'NODE_TLS_REJECT_UNAUTHORIZED') {
      const value = unwrap(node.right);
      if ((ts.isStringLiteralLike(value) && value.text === '0') || (ts.isNumericLiteral(value) && value.text === '0')) risk('tls-disabled', node, 'NODE_TLS_REJECT_UNAUTHORIZED=0');
    }
    checkCredentialAssignment(left, node.right, node);
  };

  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.AnyKeyword:
        escapes.any++;
        break;
      case ts.SyntaxKind.NonNullExpression:
        escapes.nonNull++;
        break;
      case ts.SyntaxKind.PropertyAccessExpression: {
        const access = node as ts.PropertyAccessExpression;
        const kind = envObject(access.expression);
        if (kind && kind !== 'Deno.env' && !isWrite(access)) read(access.name.text, access, kind, hasFallback(access));
        break;
      }
      case ts.SyntaxKind.ElementAccessExpression: {
        const access = node as ts.ElementAccessExpression;
        const kind = envObject(access.expression);
        const key = access.argumentExpression;
        if (kind && kind !== 'Deno.env' && ts.isStringLiteralLike(key) && !isWrite(access)) read(key.text, access, kind, hasFallback(access));
        break;
      }
      case ts.SyntaxKind.VariableDeclaration: {
        const decl = node as ts.VariableDeclaration;
        const kind = decl.initializer && envObject(decl.initializer);
        if (kind && ts.isObjectBindingPattern(decl.name)) {
          // const { PORT = '3000', HOST } = process.env
          for (const el of decl.name.elements) {
            if (el.dotDotDotToken) continue;
            const key = el.propertyName ?? el.name;
            if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) read(key.text, el, kind, !!el.initializer);
          }
        }
        checkCredentialAssignment(decl.name, decl.initializer, decl);
        break;
      }
      case ts.SyntaxKind.PropertyAssignment: {
        const prop = node as ts.PropertyAssignment;
        const name = targetName(prop.name);
        if ((name === 'rejectUnauthorized' || name === 'strictSSL') && prop.initializer.kind === ts.SyntaxKind.FalseKeyword) risk('tls-disabled', prop, `${name}: false`);
        checkCredentialAssignment(prop.name, prop.initializer, prop);
        break;
      }
      case ts.SyntaxKind.PropertyDeclaration: {
        const prop = node as ts.PropertyDeclaration;
        checkCredentialAssignment(prop.name, prop.initializer, prop);
        break;
      }
      case ts.SyntaxKind.BinaryExpression:
        checkAssignment(node as ts.BinaryExpression);
        break;
      case ts.SyntaxKind.CallExpression:
        checkCall(node as ts.CallExpression);
        break;
      case ts.SyntaxKind.NewExpression: {
        const created = node as ts.NewExpression;
        if (ts.isIdentifier(created.expression) && created.expression.text === 'Function' && created.arguments?.some(isDynamic)) risk('eval', created, 'new Function');
        break;
      }
      case ts.SyntaxKind.JsxAttribute: {
        const attr = node as ts.JsxAttribute;
        if (ts.isIdentifier(attr.name) && attr.name.text === 'dangerouslySetInnerHTML') {
          const value = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
          const html = value && ts.isObjectLiteralExpression(value) ? value.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && targetName(p.name) === '__html') : undefined;
          if (!html || isDynamic(html.initializer)) risk('html-injection', attr, 'dangerouslySetInnerHTML');
        }
        break;
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        checkSecretLiteral(node as ts.StringLiteralLike);
        break;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const m of sf.text.matchAll(TS_DIRECTIVE_RE)) {
    if (m[1] === 'expect-error') escapes.tsExpectError++;
    else escapes.tsIgnore++;
  }
  escapes.lintDisable += [...sf.text.matchAll(LINT_DISABLE_RE)].length;
  return { env, risks, escapes };
}
