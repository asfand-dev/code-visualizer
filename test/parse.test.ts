import { describe, expect, it } from 'vitest';
import { defaultNameFromId, joinRoute, parseSource, toPascalCase, type ParsedFile } from '../src/analyzer/parse.js';
import type { SymbolInfo } from '../src/shared/types.js';

/** Strip the common leading indentation so snippets can be written inline. */
function code(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');
  const lines = raw.replace(/^\n/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

function parse(text: string, id = 'src/file.tsx'): ParsedFile {
  const ext = id.slice(id.lastIndexOf('.'));
  const parsed = parseSource(id, text, ext);
  expect(parsed.parseError).toBeUndefined();
  return parsed;
}

function sym(parsed: ParsedFile, name: string): SymbolInfo {
  const s = parsed.symbols.find((x) => x.name === name);
  if (!s) throw new Error(`symbol ${name} not found; have: ${parsed.symbols.map((x) => `${x.name}:${x.kind}`).join(', ')}`);
  return s;
}

function exportNames(parsed: ParsedFile): string[] {
  return parsed.localExports.map((e) => e.name).sort();
}

/* -------------------------------------------------------------------------- */

describe('helpers', () => {
  it('toPascalCase handles kebab, snake and file names', () => {
    expect(toPascalCase('todo-item')).toBe('TodoItem');
    expect(toPascalCase('user_profile.vue')).toBe('UserProfile');
    expect(toPascalCase('Button')).toBe('Button');
  });

  it('defaultNameFromId derives names for anonymous default exports', () => {
    expect(defaultNameFromId('src/components/Button.tsx')).toBe('Button');
    expect(defaultNameFromId('src/user/index.ts')).toBe('User');
    expect(defaultNameFromId('app/dashboard/page.tsx')).toBe('DashboardPage');
    expect(defaultNameFromId('src/routes/blog/[slug]/+page.svelte')).toBe('SlugPage');
  });

  it('joinRoute normalizes slashes', () => {
    expect(joinRoute('/api/', '/users/', ':id')).toBe('/api/users/:id');
    expect(joinRoute('', '')).toBe('/');
    expect(joinRoute('users', '')).toBe('/users');
  });
});

describe('parseSource: ES module imports', () => {
  const parsed = parse(
    code`
      import React, { useState as useLocalState, type FC } from 'react';
      import type { User } from './types';
      import * as path from 'node:path';
      import './polyfills';
      import styles from './Button.module.css';

      export async function load() {
        const mod = await import('./lazy');
        return mod;
      }
    `,
    'src/a.ts',
  );

  it('records default, aliased, type-only and namespace bindings', () => {
    const react = parsed.imports.find((i) => i.specifier === 'react')!;
    expect(react.kind).toBe('import');
    expect(react.typeOnly).toBe(false);
    expect(react.names).toEqual(['default', 'useState', 'FC']);
    expect(react.bindings).toEqual([
      { local: 'React', imported: 'default', typeOnly: false },
      { local: 'useLocalState', imported: 'useState', typeOnly: false },
      { local: 'FC', imported: 'FC', typeOnly: true },
    ]);

    const types = parsed.imports.find((i) => i.specifier === './types')!;
    expect(types.typeOnly).toBe(true);
    expect(types.names).toEqual(['User']);

    const ns = parsed.imports.find((i) => i.specifier === 'node:path')!;
    expect(ns.names).toEqual(['*']);
    expect(ns.bindings[0]).toMatchObject({ local: 'path', imported: '*' });
  });

  it('distinguishes side-effect and dynamic imports', () => {
    expect(parsed.imports.find((i) => i.specifier === './polyfills')).toMatchObject({ kind: 'side-effect', names: [] });
    expect(parsed.imports.find((i) => i.specifier === './lazy')).toMatchObject({ kind: 'dynamic', line: 8 });
  });

  it('records line numbers', () => {
    expect(parsed.imports.find((i) => i.specifier === 'react')!.line).toBe(1);
    expect(parsed.imports.find((i) => i.specifier === './Button.module.css')!.line).toBe(5);
  });
});

describe('parseSource: exports and re-exports', () => {
  const parsed = parse(
    code`
      import { helper } from './helper';
      export const VERSION = '1.0.0';
      export function greet(name: string) { return 'hi ' + name; }
      export default class Greeter {}
      const internal = 1;
      export { internal as publicName };
      export type Id = string;
      export interface Shape { area(): number }
      export { helper };
      export * from './all';
      export * as utils from './utils';
      export { a, b as c } from './letters';
      export type { Props } from './props';
      export { default as Button } from './Button';
    `,
    'src/index.ts',
  );

  it('collects local exports including renamed and default ones', () => {
    expect(exportNames(parsed)).toEqual(['Id', 'Shape', 'VERSION', 'default', 'greet', 'publicName']);
    expect(parsed.localExports.find((e) => e.name === 'publicName')!.local).toBe('internal');
    expect(parsed.localExports.find((e) => e.name === 'default')!.local).toBe('Greeter');
    expect(parsed.localExports.find((e) => e.name === 'Id')!.typeOnly).toBe(true);
    expect(parsed.localExports.find((e) => e.name === 'Shape')!.typeOnly).toBe(true);
    expect(parsed.localExports.find((e) => e.name === 'greet')!.typeOnly).toBe(false);
  });

  it('marks exported symbols and the default export', () => {
    expect(sym(parsed, 'Greeter')).toMatchObject({ kind: 'class', exported: true, isDefault: true });
    expect(sym(parsed, 'internal').exported).toBe(true);
    expect(sym(parsed, 'VERSION')).toMatchObject({ kind: 'constant', exported: true });
  });

  it('records star, namespace, named, type-only and default re-exports', () => {
    const by = (spec: string) => parsed.reexports.find((r) => r.specifier === spec)!;
    expect(by('./all')).toMatchObject({ star: true, names: [] });
    expect(by('./utils')).toMatchObject({ star: false, names: [{ exported: 'utils', imported: '*' }] });
    expect(by('./letters').names).toEqual([
      { exported: 'a', imported: 'a' },
      { exported: 'c', imported: 'b' },
    ]);
    expect(by('./props')).toMatchObject({ typeOnly: true, names: [{ exported: 'Props', imported: 'Props' }] });
    expect(by('./Button').names).toEqual([{ exported: 'Button', imported: 'default' }]);
  });

  it('treats `import { x }; export { x }` as a re-export', () => {
    expect(parsed.reexports.find((r) => r.specifier === './helper')!.names).toEqual([{ exported: 'helper', imported: 'helper' }]);
    expect(exportNames(parsed)).not.toContain('helper');
  });
});

describe('parseSource: CommonJS', () => {
  it('parses require() bindings and module.exports objects', () => {
    const parsed = parse(
      code`
        const fs = require('fs');
        const { join, resolve: resolvePath } = require('path');
        const config = require('./config').database;
        require('./side-effect');

        function read(file) { return fs.readFileSync(join(__dirname, file), 'utf8'); }
        const write = (file, data) => fs.writeFileSync(resolvePath(file), data);

        module.exports = { read, write, remove: (file) => fs.unlinkSync(file) };
        module.exports.VERSION = '2';
      `,
      'lib/files.js',
    );
    expect(parsed.commonjs).toBe(true);
    expect(parsed.language).toBe('javascript');
    const byspec = (s: string) => parsed.imports.find((i) => i.specifier === s)!;
    expect(byspec('fs')).toMatchObject({ kind: 'require', names: ['*'], bindings: [{ local: 'fs', imported: '*' }] });
    expect(byspec('path').names).toEqual(['join', 'resolve']);
    expect(byspec('path').bindings.map((b) => `${b.local}=${b.imported}`)).toEqual(['join=join', 'resolvePath=resolve']);
    expect(byspec('./config')).toMatchObject({ names: ['database'], bindings: [{ local: 'config', imported: 'database' }] });
    expect(byspec('./side-effect').kind).toBe('require');

    expect(exportNames(parsed)).toEqual(expect.arrayContaining(['VERSION', 'read', 'remove', 'write']));
    expect(sym(parsed, 'read')).toMatchObject({ kind: 'function', exported: true });
    expect(sym(parsed, 'remove')).toMatchObject({ kind: 'function', exported: true });
    // the required modules are bindings, not local symbols
    expect(parsed.symbols.map((s) => s.name)).not.toContain('fs');
  });

  it('handles `exports.x = …` and `module.exports = function named()`', () => {
    const a = parse(`exports.list = async (req, res) => res.json([]);\nexports.limit = 20;\n`, 'controllers/a.js');
    expect(exportNames(a)).toEqual(['limit', 'list']);
    expect(sym(a, 'list')).toMatchObject({ kind: 'function', async: true, exported: true });
    expect(sym(a, 'limit')).toMatchObject({ kind: 'constant', exported: true });

    const b = parse(`module.exports = function errorHandler(err, req, res, next) { res.status(500).end(); };\n`, 'middleware/error.js');
    expect(sym(b, 'errorHandler')).toMatchObject({ kind: 'function', isDefault: true, exported: true });
    expect(b.localExports).toEqual([expect.objectContaining({ name: 'default', local: 'errorHandler' })]);
  });

  it('exports a class assigned to module.exports', () => {
    const parsed = parse(`class Cache { get(k) { return this.map.get(k); } }\nmodule.exports = Cache;\n`, 'lib/cache.js');
    expect(sym(parsed, 'Cache')).toMatchObject({ kind: 'class', exported: true, isDefault: true });
  });
});

describe('parseSource: React components', () => {
  const parsed = parse(
    code`
      import React, { forwardRef, memo, useContext, useEffect, useState } from 'react';
      import styled from 'styled-components';
      import { connect } from 'react-redux';
      import { ThemeContext } from './theme';
      import { Icon } from './Icon';

      interface ButtonProps {
        variant?: 'primary' | 'ghost';
        size?: 'sm' | 'lg';
      }

      type CardProps = { title: string; subtitle?: string };

      export function Card({ title, subtitle, children }: CardProps & { children?: React.ReactNode }) {
        const [open, setOpen] = useState(false);
        const theme = useContext(ThemeContext);
        useEffect(() => {}, []);
        return <section className={theme}><Header title={title} /><Icon name="x" />{open && subtitle}</section>;
      }

      const Header = ({ title }: { title: string }) => <h2>{title}</h2>;

      export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ variant, ...rest }, ref) => (
        <button ref={ref} className={variant} {...rest} />
      ));

      export const Badge: React.FC<{ count: number }> = (props) => <span>{props.count}</span>;

      export const Avatar = memo(function Avatar({ src }: { src: string }) {
        return <img src={src} />;
      });

      export const Title = styled.h1\`font-size: 2rem;\`;
      export const BigIcon = styled(Icon)\`width: 48px;\`;

      export class Legacy extends React.Component<{ name: string }> {
        render() { return <Card title={this.props.name} />; }
      }

      function Profile({ user }: { user: string }) { return <p>{user}</p>; }
      export default connect((s: unknown) => s)(Profile);

      export function formatLabel(text: string) { return text.toUpperCase(); }
      export function NotAComponent() { return 42; }
      export const renderRow = () => <tr />;
      export const Provider = ({ children }: { children: React.ReactNode }) => (
        <ThemeContext.Provider value="dark">{children}</ThemeContext.Provider>
      );
    `,
    'src/components/Card.tsx',
  );

  it('detects function-declaration components with destructured + typed props, hooks, renders and state', () => {
    const card = sym(parsed, 'Card');
    expect(card.kind).toBe('component');
    expect(card.component).toMatchObject({ framework: 'react' });
    expect(card.component!.props).toEqual(expect.arrayContaining(['title', 'subtitle', 'children']));
    expect(card.component!.hooks).toEqual(['useState', 'useContext', 'useEffect']);
    expect(card.component!.renders).toEqual(['Header', 'Icon']);
    expect(card.component!.contexts).toEqual(['ThemeContext']);
    expect(card.component!.state).toBe(1);
  });

  it('detects arrow-function components', () => {
    expect(sym(parsed, 'Header')).toMatchObject({ kind: 'component', exported: false });
    expect(sym(parsed, 'Header').component!.props).toEqual(['title']);
  });

  it('detects forwardRef components and reads props from the second type argument', () => {
    const button = sym(parsed, 'Button');
    expect(button.kind).toBe('component');
    expect(button.tags).toContain('forwardRef');
    expect(button.component!.props).toEqual(expect.arrayContaining(['variant', '...rest', 'size']));
  });

  it('reads props from React.FC<Props> annotations', () => {
    expect(sym(parsed, 'Badge').kind).toBe('component');
    expect(sym(parsed, 'Badge').component!.props).toEqual(['count']);
  });

  it('detects memo components', () => {
    const avatar = sym(parsed, 'Avatar');
    expect(avatar).toMatchObject({ kind: 'component', exported: true, tags: ['memo'] });
    expect(avatar.component!.props).toEqual(['src']);
  });

  it('detects styled-components and the component they wrap', () => {
    expect(sym(parsed, 'Title')).toMatchObject({ kind: 'component', tags: ['styled'] });
    expect(sym(parsed, 'BigIcon').component!.renders).toEqual(['Icon']);
  });

  it('detects class components', () => {
    const legacy = sym(parsed, 'Legacy');
    expect(legacy.kind).toBe('component');
    expect(legacy.extends).toEqual(['React.Component']);
    expect(legacy.component!.renders).toEqual(['Card']);
  });

  it('resolves the default export of a HOC to the wrapped component', () => {
    expect(sym(parsed, 'Profile')).toMatchObject({ kind: 'component', exported: true, isDefault: true });
    expect(parsed.localExports.find((e) => e.name === 'default')!.local).toBe('Profile');
  });

  it('does not treat plain functions or lowercase JSX helpers as components', () => {
    expect(sym(parsed, 'formatLabel').kind).toBe('function');
    expect(sym(parsed, 'NotAComponent').kind).toBe('function');
    expect(sym(parsed, 'renderRow').kind).toBe('function');
  });

  it('records <Ctx.Provider> as context usage', () => {
    expect(sym(parsed, 'Provider').component!.contexts).toEqual(['ThemeContext']);
  });

  it('flags the file as using JSX', () => {
    expect(parsed.usesJsx).toBe(true);
  });
});

describe('parseSource: hooks, contexts and stores', () => {
  const parsed = parse(
    code`
      import { createContext, useContext, useReducer } from 'react';
      import { create } from 'zustand';

      export const AuthContext = createContext<{ user?: string }>({});

      export function useAuth() {
        return useContext(AuthContext);
      }

      export const useToggle = (initial = false) => {
        const [on, toggle] = useReducer((v: boolean) => !v, initial);
        return [on, toggle] as const;
      };

      export const useBearStore = create<{ bears: number }>()((set) => ({ bears: 0 }));
    `,
    'src/state.ts',
  );

  it('classifies use* functions as hooks', () => {
    expect(sym(parsed, 'useAuth')).toMatchObject({ kind: 'hook', exported: true });
    expect(sym(parsed, 'useToggle')).toMatchObject({ kind: 'hook', exported: true });
    expect(sym(parsed, 'useToggle').params).toEqual([{ name: 'initial', optional: true, defaultValue: 'false' }]);
  });

  it('tags createContext values and zustand stores', () => {
    expect(sym(parsed, 'AuthContext').tags).toEqual(['context']);
    expect(sym(parsed, 'useBearStore').tags).toEqual(['store']);
  });

  it('records calls made by hooks', () => {
    expect([...parsed.facts.get('useAuth')!.calls.keys()]).toEqual(['useContext']);
  });
});

describe('parseSource: classes', () => {
  const parsed = parse(
    code`
      import { Injectable, Controller, Get, Param } from '@nestjs/common';

      /** Base class for all entities. Second sentence is dropped. */
      export abstract class Entity<T> implements Identifiable, Serializable {
        static count = 0;
        protected readonly createdAt: Date = new Date();
        #secret = 'x';
        abstract validate(): boolean;
        get age(): number { return Date.now() - this.createdAt.getTime(); }
        set label(value: string) {}
        toJSON() { return {}; }
      }

      @Injectable()
      export class UsersService extends Entity<User> {
        private cache = new Map<string, User>();
        constructor(private readonly repo: UsersRepository, public name?: string) { super(); }
        validate() { return true; }
        async find(id: string, ...rest: unknown[]): Promise<User | undefined> {
          if (this.cache.has(id)) return this.cache.get(id);
          const user = await this.repo.findById(id);
          this.log(user);
          return user;
        }
        private log(value: unknown) { console.log(value); }
      }

      @Controller('users')
      export class UsersController {
        constructor(private readonly users: UsersService) {}
        @Get(':id')
        findOne(@Param('id') id: string) { return this.users.find(id); }
      }
    `,
    'src/users.ts',
  );

  it('extracts heritage, abstract flag, JSDoc and members of an abstract class', () => {
    const entity = sym(parsed, 'Entity');
    expect(entity).toMatchObject({ kind: 'class', abstract: true, exported: true, doc: 'Base class for all entities.' });
    expect(entity.implements).toEqual(['Identifiable', 'Serializable']);
    const members = Object.fromEntries(entity.members!.map((m) => [m.name, m]));
    expect(members.count).toMatchObject({ kind: 'property', static: true });
    expect(members.createdAt).toMatchObject({ kind: 'property', visibility: 'protected', readonly: true, type: 'Date' });
    expect(members['#secret']).toMatchObject({ kind: 'property', visibility: 'private' });
    expect(members.validate).toMatchObject({ kind: 'method', abstract: true });
    expect(members.age).toMatchObject({ kind: 'getter', type: 'number' });
    expect(members.label).toMatchObject({ kind: 'setter' });
    expect(members.toJSON).toMatchObject({ kind: 'method' });
  });

  it('extracts decorators, constructor parameter properties and method details', () => {
    const svc = sym(parsed, 'UsersService');
    expect(svc.decorators).toEqual(['Injectable']);
    expect(svc.tags).toEqual(['injectable']);
    expect(svc.extends).toEqual(['Entity']);
    const members = Object.fromEntries(svc.members!.map((m) => [m.name, m]));
    const ctor = svc.members!.find((m) => m.kind === 'constructor')!;
    expect(ctor.name).toBe('constructor');
    expect(ctor.params!.map((p) => p.name)).toEqual(['repo', 'name']);
    expect(members.repo).toMatchObject({ kind: 'property', visibility: 'private', readonly: true, type: 'UsersRepository' });
    expect(members.name).toMatchObject({ kind: 'property', type: 'string' });
    expect(members.find).toMatchObject({ kind: 'method', async: true, type: 'Promise<User | undefined>' });
    expect(members.find.params).toEqual([
      { name: 'id', type: 'string' },
      { name: 'rest', type: 'unknown[]', rest: true },
    ]);
    expect(members.log).toMatchObject({ visibility: 'private' });
  });

  it('records this.field.method() calls and field types for cross-class linking', () => {
    const facts = parsed.facts.get('UsersService.find')!;
    expect(facts.owner).toBe('UsersService');
    expect(facts.calls.get('this.repo.findById')).toBe(1);
    expect(facts.calls.get('this.log')).toBe(1);
    const classFacts = parsed.facts.get('UsersService')!;
    expect(classFacts.fieldTypes!.get('repo')).toBe('UsersRepository');
    expect(classFacts.fieldTypes!.get('cache')).toBe('Map');
  });

  it('turns NestJS controller decorators into routes', () => {
    expect(parsed.routes).toEqual([
      expect.objectContaining({ method: 'GET', path: '/users/:id', framework: 'nestjs', type: 'api', handler: 'UsersController.findOne' }),
    ]);
    expect(sym(parsed, 'UsersController').members!.find((m) => m.name === 'findOne')!.decorators).toEqual(['Get']);
  });

  it('supports @Controller({ path }) and empty controller prefixes', () => {
    const p = parse(
      code`
        @Controller({ path: 'cats', version: '1' })
        export class CatsController {
          @Get() list() { return []; }
          @Post('bulk') bulk() {}
        }
        @Controller()
        export class RootController {
          @Get('health') health() {}
        }
      `,
      'src/cats.controller.ts',
    );
    expect(p.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /cats', 'POST /cats/bulk', 'GET /health']);
  });
});

describe('parseSource: interfaces, enums and type aliases', () => {
  const parsed = parse(
    code`
      export interface Timestamped { readonly createdAt: Date; updatedAt?: Date }
      export interface Auditable extends Timestamped, Ownable { audit(by: string): void; [key: string]: unknown }
      interface Auditable { reviewedBy?: string }

      export enum Role { Admin = 'admin', User = 'user' }
      export const enum Flags { None, A = 1 << 0 }

      export type Id = string | number;
      export type Point = { x: number; y: number };
      export type Named = Point & { name: string };
      export type Handler<T> = (event: T) => void;
    `,
    'src/types.ts',
  );

  it('extracts interface members, extends and merges re-declarations', () => {
    const ts = sym(parsed, 'Timestamped');
    expect(ts.kind).toBe('interface');
    expect(ts.members).toEqual([
      expect.objectContaining({ name: 'createdAt', kind: 'property', readonly: true, type: 'Date' }),
      expect.objectContaining({ name: 'updatedAt', kind: 'property', optional: true }),
    ]);
    const auditable = sym(parsed, 'Auditable');
    expect(auditable.extends).toEqual(['Timestamped', 'Ownable']);
    expect(auditable.members!.map((m) => `${m.kind}:${m.name}`)).toEqual(['method:audit', 'index:[key: string]', 'property:reviewedBy']);
    expect(parsed.symbols.filter((s) => s.name === 'Auditable')).toHaveLength(1);
  });

  it('extracts enums with member values and const tags', () => {
    expect(sym(parsed, 'Role')).toMatchObject({ kind: 'enum', exported: true });
    expect(sym(parsed, 'Role').members!.map((m) => [m.name, m.value])).toEqual([
      ['Admin', "'admin'"],
      ['User', "'user'"],
    ]);
    expect(sym(parsed, 'Flags').tags).toEqual(['const']);
    expect(sym(parsed, 'Flags').members!.map((m) => m.name)).toEqual(['None', 'A']);
  });

  it('extracts type aliases with their text and object members', () => {
    expect(sym(parsed, 'Id')).toMatchObject({ kind: 'type', typeText: 'string | number' });
    expect(sym(parsed, 'Point').members!.map((m) => m.name)).toEqual(['x', 'y']);
    expect(sym(parsed, 'Named').members!.map((m) => m.name)).toEqual(['name']);
    expect(sym(parsed, 'Handler').typeText).toBe('(event: T) => void');
  });

  it('collects type references for UML associations', () => {
    expect([...parsed.facts.get('Named')!.refs]).toEqual(['Point']);
  });
});

describe('parseSource: server routes', () => {
  it('extracts Express routes with middlewares, chained route() and mounts', () => {
    const parsed = parse(
      code`
        const express = require('express');
        const { auth, admin } = require('./middleware');
        const ctrl = require('./controller');
        const apiRouter = require('./api');
        const app = express();
        const router = express.Router();

        app.get('/health', (req, res) => res.send('ok'));
        router.post('/items', auth, admin, ctrl.create);
        router.route('/items/:id').get(ctrl.show).put(auth, ctrl.update).delete(auth, ctrl.destroy);
        router.get(\`/search\`, ctrl.search);
        app.use('/api', apiRouter);
        app.use('/v1', router);
        app.use(express.json());
        app.listen(3000);
      `,
      'server.js',
    );
    const sig = parsed.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(sig).toEqual(
      ['GET /health', 'POST /items', 'GET /items/:id', 'PUT /items/:id', 'DELETE /items/:id', 'GET /search', 'USE /api', 'USE /v1'].sort(),
    );
    const post = parsed.routes.find((r) => r.method === 'POST')!;
    expect(post).toMatchObject({ framework: 'express', type: 'api', handler: 'ctrl.create', middlewares: ['auth', 'admin'], receiver: 'router' });
    expect(parsed.routes.find((r) => r.method === 'PUT')).toMatchObject({ handler: 'ctrl.update', middlewares: ['auth'], receiver: 'router' });
    expect(parsed.routes.find((r) => r.method === 'GET' && r.path === '/health')!.handler).toBe('(inline)');
    expect(parsed.routes.find((r) => r.path === '/api')).toMatchObject({ type: 'middleware', mountTargets: ['apiRouter'] });
  });

  it('detects mounts of inline require() calls', () => {
    const parsed = parse(`const express = require('express');\nconst app = express();\napp.use('/api', require('./routes'));\n`, 'app.js');
    expect(parsed.routes).toEqual([expect.objectContaining({ method: 'USE', path: '/api', mountSpecifiers: ['./routes'] })]);
  });

  it('extracts fastify-style route objects', () => {
    const parsed = parse(
      code`
        import Fastify from 'fastify';
        const server = Fastify();
        server.route({ method: ['GET', 'HEAD'], url: '/items', handler: listItems });
        server.get('/items/:id', async () => ({}));
      `,
      'src/server.ts',
    );
    expect(parsed.routes.map((r) => `${r.framework} ${r.method} ${r.path}`)).toEqual([
      'fastify GET /items',
      'fastify HEAD /items',
      'fastify GET /items/:id',
    ]);
  });

  it('does not mistake HTTP clients or Map/URLSearchParams lookups for routes', () => {
    const parsed = parse(
      code`
        import axios from 'axios';
        const api = axios.create({ baseURL: '/api' });
        export async function load(cache: Map<string, string>) {
          await axios.get('/users', { params: { page: 1 } });
          await api.get('/users/1', { timeout: 100 });
          await api.post('/users', { name: 'x' });
          return cache.get('/users');
        }
      `,
      'src/api/users.ts',
    );
    expect(parsed.routes).toEqual([]);
  });

  it('does not treat a Vue app instance as an HTTP server', () => {
    const parsed = parse(
      code`
        import { createApp } from 'vue';
        import App from './App.vue';
        import router from './router';
        const app = createApp(App);
        app.use(router);
        app.mount('#app');
      `,
      'src/main.ts',
    );
    expect(parsed.routes).toEqual([]);
  });
});

describe('parseSource: client-side routes', () => {
  it('extracts nested JSX <Route> trees with index and absolute paths', () => {
    const parsed = parse(
      code`
        import { Routes, Route } from 'react-router-dom';
        export function AppRoutes() {
          return (
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="settings" element={<Settings />}>
                  <Route path="profile" element={<Profile />} />
                </Route>
                <Route path="/about" element={<About />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          );
        }
      `,
      'src/AppRoutes.tsx',
    );
    const routes = parsed.routes.map((r) => `${r.path} ${r.component}`);
    expect(routes.slice(0, 5)).toEqual(['/ Layout', '/ Home', '/settings Settings', '/settings/profile Profile', '/about About']);
    // A top-level splat may be reported as "*" or "/*" (equivalent in react-router).
    expect(['* NotFound', '/* NotFound']).toContain(routes[5]);
    expect(routes).toHaveLength(6);
    expect(parsed.routes.every((r) => r.framework === 'react-router' && r.type === 'page' && r.method === 'PAGE')).toBe(true);
  });

  it('extracts createBrowserRouter objects with children, Component and lazy imports', () => {
    const parsed = parse(
      code`
        import { createBrowserRouter } from 'react-router-dom';
        import Root from './Root';
        export const router = createBrowserRouter([
          {
            path: '/',
            element: <Root />,
            children: [
              { path: 'team', Component: Team },
              { path: 'reports/:id', lazy: () => import('./pages/Report') },
            ],
          },
        ]);
      `,
      'src/router.tsx',
    );
    expect(parsed.routes.map((r) => ({ path: r.path, component: r.component, componentSpecifier: r.componentSpecifier }))).toEqual([
      { path: '/', component: 'Root', componentSpecifier: undefined },
      { path: '/team', component: 'Team', componentSpecifier: undefined },
      { path: '/reports/:id', component: undefined, componentSpecifier: './pages/Report' },
    ]);
  });

  it('extracts vue-router configs with nested children and redirects', () => {
    const parsed = parse(
      code`
        import { createRouter, createWebHistory } from 'vue-router';
        import Home from './views/Home.vue';
        export default createRouter({
          history: createWebHistory(),
          routes: [
            { path: '/', component: Home },
            { path: '/users', component: () => import('./views/Users.vue'), children: [
              { path: ':id', component: () => import('./views/User.vue') },
            ] },
            { path: '/old', redirect: '/' },
          ],
        });
      `,
      'src/router/index.ts',
    );
    expect(parsed.routes.map((r) => `${r.method} ${r.path}`)).toEqual(['PAGE /', 'PAGE /users', 'PAGE /users/:id', 'REDIRECT /old']);
    expect(parsed.routes.every((r) => r.framework === 'vue-router')).toBe(true);
    expect(parsed.routes[2].componentSpecifier).toBe('./views/User.vue');
  });
});

describe('parseSource: Vue single-file components', () => {
  it('parses <script setup> props, emits, hooks and template components', () => {
    const parsed = parse(
      code`
        <template>
          <div>
            <TodoItem v-for="t in todos" :key="t.id" :todo="t" />
            <base-button @click="emit('save', 1)">Save</base-button>
            <router-link to="/">Home</router-link>
            <transition-group><span /></transition-group>
          </div>
        </template>

        <script setup lang="ts">
        import { computed } from 'vue';
        import TodoItem from './TodoItem.vue';
        import { useTodos } from '@/composables/useTodos';
        const props = defineProps<{ title: string; todos: Todo[]; dense?: boolean }>();
        const emit = defineEmits<{ (e: 'save', id: number): void; (e: 'cancel'): void }>();
        const { todos } = useTodos();
        const heading = computed(() => props.title.toUpperCase());
        </script>
      `,
      'src/components/TodoPanel.vue',
    );
    expect(parsed.language).toBe('vue');
    const comp = parsed.symbols.find((s) => s.isDefault)!;
    expect(comp).toMatchObject({ name: 'TodoPanel', kind: 'component', exported: true });
    expect(comp.component!.framework).toBe('vue');
    expect(comp.component!.props).toEqual(['title', 'todos', 'dense']);
    expect(comp.component!.emits).toEqual(['save', 'cancel']);
    expect(comp.component!.hooks).toEqual(['useTodos']);
    expect(comp.component!.renders).toEqual(expect.arrayContaining(['TodoItem', 'BaseButton', 'RouterLink']));
    expect(comp.component!.renders).not.toContain('TransitionGroup');
    expect(parsed.imports.map((i) => i.specifier)).toEqual(['vue', './TodoItem.vue', '@/composables/useTodos']);
    // script-setup locals are not module exports
    expect(exportNames(parsed)).toEqual(['default']);
  });

  it('maps script line numbers back to the .vue file', () => {
    const parsed = parse(
      code`
        <template>
          <p>{{ msg }}</p>
        </template>

        <script setup lang="ts">
        import { ref } from 'vue';
        function shout() { return 'hi'; }
        </script>
      `,
      'src/components/Hello.vue',
    );
    expect(parsed.imports[0].line).toBe(6);
    expect(sym(parsed, 'shout').line).toBe(7);
  });

  it('supports withDefaults, array and object props, and Vue 3.3 named-tuple emits', () => {
    const a = parse(
      `<script setup lang="ts">\nconst p = withDefaults(defineProps<{ size?: number; label: string }>(), { size: 1 });\nconst e = defineEmits<{ change: [value: string]; close: [] }>();\n</script>\n<template><i /></template>\n`,
      'src/A.vue',
    );
    const ca = a.symbols.find((s) => s.isDefault)!.component!;
    expect(ca.props).toEqual(['size', 'label']);
    expect(ca.emits).toEqual(['change', 'close']);

    const b = parse(`<script setup>\ndefineProps(['modelValue', 'items']);\ndefineEmits(['update:modelValue']);\n</script>\n`, 'src/B.vue');
    const cb = b.symbols.find((s) => s.isDefault)!.component!;
    expect(cb.props).toEqual(['modelValue', 'items']);
    expect(cb.emits).toEqual(['update:modelValue']);

    const c = parse(`<script setup>\ndefineProps({ id: { type: Number, required: true }, label: String });\n</script>\n`, 'src/C.vue');
    expect(c.symbols.find((s) => s.isDefault)!.component!.props).toEqual(['id', 'label']);
  });

  it('parses Options API components with props arrays, components and emits', () => {
    const parsed = parse(
      code`
        <script>
        import TodoItem from './TodoItem.vue';
        export default {
          name: 'TodoList',
          components: { TodoItem },
          props: ['items', 'filter'],
          emits: { toggle: null },
          data() { return { open: false }; },
        };
        </script>
        <template><ul><todo-item v-for="i in items" :key="i.id" /></ul></template>
      `,
      'src/components/TodoList.vue',
    );
    const comp = parsed.symbols.find((s) => s.isDefault)!;
    expect(comp.name).toBe('TodoList');
    expect(comp.component).toMatchObject({ framework: 'vue', props: ['items', 'filter'], emits: ['toggle'] });
    expect(comp.component!.renders).toEqual(['TodoItem']);
    expect(parsed.symbols.filter((s) => s.isDefault)).toHaveLength(1);
  });
});

describe('parseSource: Svelte components', () => {
  it('parses Svelte 5 $props() destructuring and markup components', () => {
    const parsed = parse(
      code`
        <script lang="ts">
          import Icon from './Icon.svelte';
          import { formatDate } from '$lib/utils';
          let { title, date, compact = false, ...rest }: Props = $props();
          let label = $derived(formatDate(date));
        </script>

        <article {...rest}>
          <Icon name="post" />
          <h2>{title}</h2>
          <svelte:head><title>{title}</title></svelte:head>
        </article>
      `,
      'src/lib/components/PostCard.svelte',
    );
    expect(parsed.language).toBe('svelte');
    const comp = parsed.symbols.find((s) => s.isDefault)!;
    expect(comp).toMatchObject({ name: 'PostCard', kind: 'component' });
    expect(comp.component!.framework).toBe('svelte');
    expect(comp.component!.props).toEqual(expect.arrayContaining(['title', 'date', 'compact']));
    expect(comp.component!.renders).toEqual(['Icon']);
    expect(parsed.imports.map((i) => i.specifier)).toEqual(['./Icon.svelte', '$lib/utils']);
  });

  it('treats Svelte 4 `export let` as props, not module exports, but keeps context="module" exports', () => {
    const parsed = parse(
      code`
        <script context="module" lang="ts">
          export const prerender = true;
        </script>
        <script lang="ts">
          export let title: string;
          export let subtitle = '';
          const upper = title.toUpperCase();
        </script>
        <h1>{upper}</h1><slot />
      `,
      'src/lib/Header.svelte',
    );
    const comp = parsed.symbols.find((s) => s.isDefault)!;
    expect(comp.component!.props).toEqual(['title', 'subtitle']);
    expect(exportNames(parsed)).toEqual(['default', 'prerender']);
    expect(parsed.symbols.map((s) => s.name)).not.toContain('title');
  });
});

describe('parseSource: complexity', () => {
  const parsed = parse(
    code`
      export function grade(score: number, bonus?: number): string {
        const total = score + (bonus ?? 0);
        if (total > 90) return 'A';
        else if (total > 80) return 'B';
        for (const x of [1, 2]) {
          if (x && total) continue;
        }
        switch (total) {
          case 1:
            break;
          case 2:
            break;
          default:
        }
        try {
          JSON.parse('{}');
        } catch {
          return 'E';
        }
        return total > 50 ? 'C' : 'F';
      }

      export function simple() { return 1; }

      export function looping(items: string[]) {
        let i = 0;
        while (i < items.length) i++;
        do { i--; } while (i > 0 || items.length === 0);
        return i;
      }
    `,
    'src/grade.ts',
  );

  it('computes cyclomatic complexity per function', () => {
    // 1 + ?? + if + else-if + for-of + if + && + 2 cases + catch + ternary
    expect(sym(parsed, 'grade').complexity).toBe(11);
    expect(sym(parsed, 'simple').complexity).toBe(1);
    // 1 + while + do-while + ||
    expect(sym(parsed, 'looping').complexity).toBe(4);
  });

  it('computes file complexity and max complexity', () => {
    expect(parsed.maxComplexity).toBe(11);
    expect(parsed.complexity).toBe(1 + 10 + 3);
  });

  it('counts lines and source lines', () => {
    const p = parse('// header comment\n\nconst a = 1;\n/* block\n   comment */\nconst b = 2;\n', 'src/x.ts');
    expect(p.loc).toBe(6);
    expect(p.sloc).toBe(2);
  });
});

describe('parseSource: TODOs, directives, docs', () => {
  it('extracts TODO / FIXME / HACK / XXX comments with line numbers', () => {
    const parsed = parse(
      code`
        // TODO: handle pagination
        export function list() {
          /* FIXME broken on Safari */
          return []; // HACK: workaround for issue #12
        }
        /**
         * XXX remove after v2
         */
        const label = 'TODO list'; // not a todo marker in a string
      `,
      'src/list.ts',
    );
    expect(parsed.todos).toEqual([
      { line: 1, tag: 'TODO', text: 'handle pagination' },
      { line: 3, tag: 'FIXME', text: 'broken on Safari' },
      { line: 4, tag: 'HACK', text: 'workaround for issue #12' },
      { line: 7, tag: 'XXX', text: 'remove after v2' },
    ]);
  });

  it('extracts TODOs from Vue templates', () => {
    const parsed = parse(`<template>\n  <!-- TODO: add empty state -->\n  <ul />\n</template>\n`, 'src/List.vue');
    expect(parsed.todos).toEqual([{ line: 2, tag: 'TODO', text: 'add empty state' }]);
  });

  it("records 'use client' / 'use server' directives and tags server actions", () => {
    const client = parse(`'use client';\nimport { useState } from 'react';\nexport function Counter() { const [n] = useState(0); return <b>{n}</b>; }\n`, 'components/Counter.tsx');
    expect(client.directives).toEqual(['use client']);

    const server = parse(`'use server';\nexport async function save(data: FormData) {}\nexport function sync() {}\n`, 'app/actions.ts');
    expect(server.directives).toEqual(['use server']);
    expect(sym(server, 'save').tags).toEqual(['server-action']);
    expect(sym(server, 'sync').tags).toBeUndefined();
  });

  it('extracts the leading file description and JSDoc summaries', () => {
    const parsed = parse(
      code`
        /**
         * Formatting helpers shared by the UI.
         */

        /** Formats a price. Uses Intl under the hood. */
        export function price(n: number) { return n.toFixed(2); }
      `,
      'src/format.ts',
    );
    expect(parsed.description).toBe('Formatting helpers shared by the UI.');
    expect(sym(parsed, 'price').doc).toBe('Formats a price.');
  });

  it('flags generated files', () => {
    const parsed = parse(`// @generated by protoc. DO NOT EDIT.\nexport const x = 1;\n`, 'src/gen/x.ts');
    expect(parsed.isGenerated).toBe(true);
  });

  it('never throws on broken input', () => {
    const parsed = parseSource('src/broken.ts', 'export function ( {{{ <<< ', '.ts');
    expect(parsed).toBeDefined();
    expect(parsed.loc).toBe(1);
  });
});

describe('parseSource: call sites (query-core)', () => {
  it('records the line and argument count of calls, `new` and JSX renders', () => {
    const parsed = parse(
      code`
        import { format, Widget } from './lib';

        export function Panel({ items }: { items: string[] }) {
          const a = format(items[0], 2);
          const b = format(...items);
          const w = new Widget();
          return (
            <section>
              <Widget title={format(a)} />
              {b}
            </section>
          );
        }
      `,
      'src/Panel.tsx',
    );
    const sites = parsed.facts.get('Panel')!.sites!;
    expect(sites.get('format')).toEqual([
      [4, 2],
      [5, -1],
      [9, 1],
    ]);
    expect(sites.get('new:Widget')).toEqual([[6, 0]]);
    expect(sites.get('jsx:Widget')).toEqual([[9, 0]]);
  });

  it('keeps at most 20 sites per callee and records class methods under their own key', () => {
    const calls = Array.from({ length: 25 }, (_, i) => `  log(${i});`).join('\n');
    const parsed = parse(`export function noisy() {\n${calls}\n}\nexport class Svc {\n  run() {\n    return this.step(1);\n  }\n  step(n: number) { return n; }\n}\n`, 'src/noisy.ts');
    const log = parsed.facts.get('noisy')!.sites!.get('log')!;
    expect(log).toHaveLength(20);
    expect(log[0]).toEqual([2, 1]);
    expect(parsed.facts.get('noisy')!.calls.get('log')).toBe(25);
    expect(parsed.facts.get('Svc.run')!.sites!.get('this.step')).toEqual([[30, 1]]);
  });

  it('maps call sites in Vue, Svelte and Astro scripts to lines of the whole file', () => {
    const vue = parse(
      code`
        <template>
          <p>{{ msg }}</p>
        </template>

        <script setup lang="ts">
        import { ref } from 'vue';
        import { greet } from './greet';
        const msg = ref(greet('you'));
        function shout() { return greet('YOU', true); }
        </script>
      `,
      'src/components/Hello.vue',
    );
    expect(vue.facts.get('shout')!.sites!.get('greet')).toEqual([[9, 2]]);
    // Script-level code belongs to the component itself.
    expect(vue.facts.get('Hello')!.sites!.get('greet')).toEqual(expect.arrayContaining([[8, 1]]));
    // Components rendered in the template, PascalCase or kebab-case.
    const list = parse(`<template>\n  <ul>\n    <todo-item v-for="t in items" />\n  </ul>\n  <Footer />\n</template>\n<script setup>\nimport TodoItem from './TodoItem.vue';\nimport Footer from './Footer.vue';\n</script>\n`, 'src/List.vue');
    expect(list.facts.get('List')!.sites!.get('jsx:TodoItem')).toEqual([[3, 0]]);
    expect(list.facts.get('List')!.sites!.get('jsx:Footer')).toEqual([[5, 0]]);
    const markup = parse(`<script>\n  import Card from './Card.svelte';\n</script>\n\n<Card />\n`, 'src/Page.svelte');
    expect(markup.facts.get('Page')!.sites!.get('jsx:Card')).toEqual([[5, 0]]);
    const svelte = parse(`<h1>hi</h1>\n<script>\n  import { track } from './t';\n  track('x');\n</script>\n`, 'src/Hi.svelte');
    expect(svelte.facts.get('Hi')!.sites!.get('track')).toEqual([[4, 1]]);
    const astro = parse(`---\nimport { load } from './data';\nconst data = await load(1, 2);\n---\n<p>{data}</p>\n<script>\n  function boot() { start(); }\n</script>\n`, 'src/pages/index.astro');
    expect(sym(astro, 'data').line).toBe(3);
    expect(astro.facts.get('Pages')!.sites!.get('load')).toEqual([[3, 2]]);
    // Client scripts after the frontmatter keep their position in the file.
    expect(sym(astro, 'boot').line).toBe(7);
    expect(astro.facts.get('boot')!.sites!.get('start')).toEqual([[7, 0]]);
  });
});
