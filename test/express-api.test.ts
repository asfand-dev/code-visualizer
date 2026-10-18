import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportData } from '../src/shared/types.js';
import { analyzeFixture, expectEdge, expectRoute, expectSymbolEdge, getFile, getSymbol, routeSignatures } from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyzeFixture('express-api');
});

describe('express-api: project', () => {
  it('detects Express + Mongoose and plain JavaScript', () => {
    const ids = data.project.frameworks.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['express', 'mongoose']));
    expect(data.project.typescript).toBe(false);
    expect(data.project.languages).toEqual([expect.objectContaining({ language: 'javascript', files: 15 })]);
    expect(data.project).toMatchObject({ name: 'express-api', version: '1.4.2', license: 'MIT' });
  });

  it('parses all files without warnings or unresolved requires', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files).toHaveLength(15);
    expect(data.files.filter((f) => f.unresolved.length).map((f) => [f.id, f.unresolved])).toEqual([]);
  });

  it('finds the package.json "main" entry and the conventional app.js', () => {
    expect(getFile(data, 'server.js')).toMatchObject({ isEntry: true, entryReason: 'package.json "main"', kind: 'entry' });
    expect(getFile(data, 'app.js').isEntry).toBe(true);
    expect(data.files.filter((f) => f.isEntry).map((f) => f.id).sort()).toEqual(['app.js', 'server.js']);
  });

  it('classifies MVC-style folders', () => {
    const kinds = Object.fromEntries(data.files.map((f) => [f.id, f.kind]));
    expect(kinds).toMatchObject({
      'controllers/usersController.js': 'controller',
      'controllers/postsController.js': 'controller',
      'models/User.js': 'model',
      'models/Post.js': 'model',
      'middleware/auth.js': 'middleware',
      'middleware/errorHandler.js': 'middleware',
      'services/UserService.js': 'service',
      'routes/index.js': 'router',
      'routes/users.js': 'router',
      'routes/posts.js': 'router',
      'utils/errors.js': 'util',
      'utils/object.js': 'util',
    });
  });

  it('does not classify the Express application module app.js as a config file', () => {
    expect(getFile(data, 'app.js').kind).toBeOneOf(['entry', 'router']);
  });
});

describe('express-api: CommonJS module graph', () => {
  it('turns require() calls into edges, including inline require() in app.use', () => {
    expectEdge(data, 'server.js', 'app.js', 'require');
    expectEdge(data, 'app.js', 'routes/index.js', 'require');
    expectEdge(data, 'routes/index.js', 'routes/users.js', 'require');
    expectEdge(data, 'routes/users.js', 'controllers/usersController.js', 'require');
    expect(expectEdge(data, 'routes/posts.js', 'controllers/postsController.js').names.sort()).toEqual(['createPost', 'getPost', 'listPosts']);
    expect(expectEdge(data, 'server.js', 'config/db.js').names).toEqual(['connectDb']);
  });

  it('reads module.exports objects, exports.x assignments and module.exports.x', () => {
    const names = (id: string) => getFile(data, id).exports.map((e) => e.name).sort();
    expect(names('controllers/usersController.js')).toEqual(['create', 'getById', 'list', 'remove', 'update']);
    expect(names('controllers/postsController.js')).toEqual(['createPost', 'getPost', 'listPosts']);
    expect(names('middleware/auth.js')).toEqual(['default', 'requireRole']);
    expect(names('utils/errors.js')).toEqual(['AppError', 'NotFoundError']);
    expect(getSymbol(data, 'controllers/postsController.js#getPost')).toMatchObject({ kind: 'function', async: true, exported: true });
    expect(getSymbol(data, 'middleware/errorHandler.js#errorHandler')).toMatchObject({ kind: 'function', isDefault: true });
  });

  it('tags mongoose models', () => {
    expect(getFile(data, 'models/User.js').symbols.find((s) => s.name === 'userSchema')!.tags).toEqual(['model']);
  });

  it('reads class members of the service', () => {
    const svc = getSymbol(data, 'services/UserService.js#UserService');
    expect(svc).toMatchObject({ kind: 'class', isDefault: true, doc: 'Business logic around users; the mongoose model is injected for testability.' });
    expect(svc.members!.map((m) => m.name)).toEqual(['constructor', 'findAll', 'findById', 'create', 'update', 'remove']);
    expect(svc.members!.filter((m) => m.async).map((m) => m.name)).toEqual(['findAll', 'findById', 'create', 'update', 'remove']);
  });
});

describe('express-api: routes', () => {
  it('prefixes routes through nested app.use / router.use mounts', () => {
    const api = routeSignatures(data, (r) => r.type === 'api').sort();
    expect(api).toEqual(
      [
        'GET /health',
        'GET /api/users',
        'POST /api/users',
        'GET /api/users/:id',
        'PATCH /api/users/:id',
        'DELETE /api/users/:id',
        'GET /api/posts',
        'GET /api/posts/:postId',
        'POST /api/posts',
      ].sort(),
    );
    expect(data.routes.every((r) => r.framework === 'express')).toBe(true);
  });

  it('records handlers, middlewares and params, and links handlers to controller functions', () => {
    expectRoute(data, 'GET', '/api/users', {
      file: 'routes/users.js',
      handler: 'controller.list',
      middlewares: ['auth'],
      handlerSymbol: 'controllers/usersController.js#list',
    });
    expectRoute(data, 'GET', '/api/users/:id', { handler: 'controller.getById', params: ['id'], handlerSymbol: 'controllers/usersController.js#getById' });
    const del = expectRoute(data, 'DELETE', '/api/users/:id', { handlerSymbol: 'controllers/usersController.js#remove' });
    expect(del.middlewares).toHaveLength(2);
    expect(del.middlewares![0]).toBe('auth');
    expectRoute(data, 'GET', '/api/posts/:postId', { file: 'routes/posts.js', params: ['postId'], handlerSymbol: 'controllers/postsController.js#getPost' });
    expectRoute(data, 'POST', '/api/posts', { middlewares: ['auth'], handlerSymbol: 'controllers/postsController.js#createPost' });
    expectRoute(data, 'GET', '/health', { file: 'app.js', handler: '(inline)' });
  });

  it('reports router mounts with their full prefix', () => {
    const mounts = data.routes.filter((r) => r.type === 'mount').map((r) => `${r.path} ${r.file}`).sort();
    expect(mounts).toEqual(['/api app.js', '/api/posts routes/index.js', '/api/users routes/index.js']);
  });
});

describe('express-api: symbol edges', () => {
  it('links class inheritance, instantiation and same-class method calls', () => {
    expectSymbolEdge(data, 'extends', 'utils/errors.js#NotFoundError', 'utils/errors.js#AppError');
    expectSymbolEdge(data, 'instantiates', 'services/UserService.js#UserService.findById', 'utils/errors.js#NotFoundError');
    expectSymbolEdge(data, 'calls', 'services/UserService.js#UserService.update', 'services/UserService.js#UserService.findById');
    expectSymbolEdge(data, 'instantiates', 'controllers/usersController.js#userService', 'services/UserService.js#UserService');
    expectSymbolEdge(data, 'instantiates', 'middleware/auth.js#auth', 'utils/errors.js#AppError');
  });

  it('links calls to destructured require() bindings', () => {
    expectSymbolEdge(data, 'calls', 'controllers/usersController.js#create', 'utils/object.js#pick');
    expectSymbolEdge(data, 'calls', 'controllers/usersController.js#update', 'utils/object.js#pick');
  });

  it('links controller functions to the service methods they call on a module-level instance', () => {
    // const userService = new UserService(User); … userService.findAll(…)
    expectSymbolEdge(data, 'calls', 'controllers/usersController.js#list', 'services/UserService.js#UserService.findAll');
    expectSymbolEdge(data, 'calls', 'controllers/usersController.js#remove', 'services/UserService.js#UserService.remove');
  });
});

describe('express-api: insights', () => {
  it('flags the declared-but-never-required dependency', () => {
    expect(data.insights.unusedDependencies).toEqual(['morgan']);
    expect(data.packages.find((p) => p.name === 'morgan')).toMatchObject({ unused: true, importedBy: [] });
  });

  it('flags the required-but-undeclared package, and not builtins', () => {
    expect(data.insights.missingDependencies).toEqual([{ name: 'express-rate-limit', files: ['app.js'] }]);
    expect(data.packages.find((p) => p.name === 'crypto')).toMatchObject({ builtin: true });
    expect(data.packages.find((p) => p.name === 'dotenv')).toMatchObject({ declaredAs: 'dependencies', importedBy: ['server.js'] });
  });

  it('reports the unused CommonJS export', () => {
    expect(data.insights.unusedExports.map((u) => `${u.file}#${u.name}`)).toEqual(['utils/object.js#omit']);
  });

  it('has no orphans or cycles', () => {
    expect(data.insights.orphans).toEqual([]);
    expect(data.insights.cycles).toEqual([]);
  });

  it('collects TODO / FIXME comments', () => {
    const todos = data.files.flatMap((f) => f.todos.map((t) => `${f.id}:${t.tag}:${t.text}`));
    expect(todos.sort()).toEqual([
      'config/db.js:FIXME:add retry with backoff for flaky container start-up',
      'controllers/postsController.js:TODO:sanitize the markdown body before saving',
    ]);
  });
});
