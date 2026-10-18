import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportData } from '../src/shared/types.js';
import { analyzeFixture, expectEdge, expectRoute, expectSymbolEdge, getFile, getSymbol, routeSignatures } from './helpers.js';

let data: ReportData;
beforeAll(async () => {
  data = await analyzeFixture('nest-api');
});

const CTRL = 'src/users/users.controller.ts#UsersController';
const SVC = 'src/users/users.service.ts#UsersService';
const REPO = 'src/users/users.repository.ts#UsersRepository';
const USER = 'src/users/entities/user.entity.ts#User';

describe('nest-api: project', () => {
  it('detects NestJS', () => {
    expect(data.project.frameworks.map((f) => f.id)).toEqual(expect.arrayContaining(['nestjs', 'typescript']));
    expect(data.project.frameworks.find((f) => f.id === 'nestjs')!.category).toBe('backend');
  });

  it('parses all files without warnings or unresolved imports', () => {
    expect(data.warnings).toEqual([]);
    expect(data.files).toHaveLength(14);
    expect(data.files.filter((f) => f.unresolved.length).map((f) => [f.id, f.unresolved])).toEqual([]);
  });

  it('marks src/main.ts as entry', () => {
    expect(data.files.filter((f) => f.isEntry).map((f) => f.id)).toEqual(['src/main.ts']);
  });

  it('classifies Nest building blocks', () => {
    const kinds = Object.fromEntries(data.files.map((f) => [f.id, f.kind]));
    expect(kinds).toMatchObject({
      'src/users/users.controller.ts': 'controller',
      'src/users/users.service.ts': 'service',
      'src/users/entities/user.entity.ts': 'model',
      'src/users/dto/create-user.dto.ts': 'model',
      'src/common/entities/base.entity.ts': 'model',
      'src/common/interfaces/repository.interface.ts': 'types',
    });
  });

  it('classifies app.controller.ts / app.module.ts like their feature-module counterparts (not as config)', () => {
    expect(getFile(data, 'src/app.controller.ts').kind).toBe('controller');
    expect(getFile(data, 'src/app.module.ts').kind).toBe(getFile(data, 'src/users/users.module.ts').kind);
    expect(getFile(data, 'src/app.module.ts').kind).not.toBe('config');
  });

  it('resolves baseUrl-relative imports (src/…)', () => {
    expect(expectEdge(data, 'src/users/users.module.ts', 'src/users/users.repository.ts').specifier).toBe('src/users/users.repository');
  });
});

describe('nest-api: routes', () => {
  it('builds full paths from @Controller prefixes and method decorators', () => {
    expect(routeSignatures(data).sort()).toEqual(
      ['GET /health', 'GET /users', 'GET /users/:id', 'POST /users', 'PATCH /users/:id', 'DELETE /users/:id'].sort(),
    );
    expect(data.routes.every((r) => r.framework === 'nestjs' && r.type === 'api')).toBe(true);
  });

  it('links routes to controller methods', () => {
    expectRoute(data, 'GET', '/users/:id', { file: 'src/users/users.controller.ts', handler: 'UsersController.findOne', handlerSymbol: `${CTRL}.findOne`, params: ['id'] });
    expectRoute(data, 'POST', '/users', { handlerSymbol: `${CTRL}.create` });
    expectRoute(data, 'GET', '/health', { file: 'src/app.controller.ts', handlerSymbol: 'src/app.controller.ts#AppController.health' });
  });
});

describe('nest-api: classes, interfaces and enums', () => {
  it('reads decorators and tags', () => {
    expect(getSymbol(data, CTRL)).toMatchObject({ decorators: ['Controller'], tags: ['controller'] });
    expect(getSymbol(data, SVC)).toMatchObject({ decorators: ['Injectable'], tags: ['injectable'] });
    expect(getSymbol(data, 'src/app.module.ts#AppModule')).toMatchObject({ decorators: ['Module'], tags: ['module'] });
    const ctrl = getSymbol(data, CTRL);
    expect(ctrl.members!.find((m) => m.name === 'findOne')!.decorators).toEqual(['Get']);
    expect(ctrl.members!.find((m) => m.name === 'create')!.decorators).toEqual(['Post', 'HttpCode']);
  });

  it('reads constructor parameter properties (dependency injection)', () => {
    expect(getSymbol(data, SVC).members!.find((m) => m.name === 'repo')).toMatchObject({
      kind: 'property',
      visibility: 'private',
      readonly: true,
      type: 'UsersRepository',
    });
    const user = getSymbol(data, USER);
    expect(user.members!.filter((m) => m.kind === 'property').map((m) => m.name)).toEqual(['createdBy', 'updatedBy', 'email', 'name', 'role']);
    expect(user.members!.find((m) => m.name === 'isAdmin')!.kind).toBe('getter');
  });

  it('reads the abstract base class and DTO property decorators', () => {
    const base = getSymbol(data, 'src/common/entities/base.entity.ts#BaseEntity');
    expect(base.abstract).toBe(true);
    expect(base.members!.find((m) => m.name === 'validate')).toMatchObject({ kind: 'method', abstract: true });
    const dto = getSymbol(data, 'src/users/dto/create-user.dto.ts#CreateUserDto');
    const decorators = Object.fromEntries(dto.members!.map((m) => [m.name, m.decorators]));
    expect(decorators).toEqual({ email: ['IsEmail'], name: ['IsString', 'MinLength'], role: ['IsOptional', 'IsEnum'] });
    expect(dto.members!.find((m) => m.name === 'role')!.optional).toBe(true);
  });

  it('reads interfaces (incl. generic ones) and enums', () => {
    const repo = getSymbol(data, 'src/common/interfaces/repository.interface.ts#Repository');
    expect(repo.kind).toBe('interface');
    expect(repo.members!.map((m) => m.name)).toEqual(['findAll', 'findById', 'save', 'delete']);
    expect(getSymbol(data, 'src/common/interfaces/auditable.interface.ts#Auditable').extends).toEqual(['Timestamped']);
    const role = getSymbol(data, 'src/users/enums/role.enum.ts#Role');
    expect(role.kind).toBe('enum');
    expect(role.members!.map((m) => `${m.name}=${m.value}`)).toEqual(["Admin='admin'", "Editor='editor'", "Viewer='viewer'"]);
  });
});

describe('nest-api: symbol edges (UML)', () => {
  it('links class and interface inheritance', () => {
    expectSymbolEdge(data, 'extends', USER, 'src/common/entities/base.entity.ts#BaseEntity');
    expectSymbolEdge(data, 'implements', USER, 'src/common/interfaces/auditable.interface.ts#Auditable');
    expectSymbolEdge(data, 'implements', REPO, 'src/common/interfaces/repository.interface.ts#Repository');
    expectSymbolEdge(data, 'implements', 'src/common/entities/base.entity.ts#BaseEntity', 'src/common/interfaces/repository.interface.ts#Identifiable');
    expectSymbolEdge(data, 'extends', 'src/common/interfaces/auditable.interface.ts#Auditable', 'src/common/interfaces/auditable.interface.ts#Timestamped');
  });

  it('links this.<injected>.<method>() calls across classes', () => {
    expectSymbolEdge(data, 'calls', `${CTRL}.findAll`, `${SVC}.findAll`);
    expectSymbolEdge(data, 'calls', `${CTRL}.findOne`, `${SVC}.findOne`);
    expectSymbolEdge(data, 'calls', `${CTRL}.remove`, `${SVC}.remove`);
    expectSymbolEdge(data, 'calls', `${SVC}.findOne`, `${REPO}.findById`);
    expectSymbolEdge(data, 'calls', `${SVC}.create`, `${REPO}.save`);
    expectSymbolEdge(data, 'calls', `${SVC}.update`, `${SVC}.findOne`);
    expectSymbolEdge(data, 'instantiates', `${SVC}.create`, USER);
  });

  it('links injected dependencies and typed fields with `uses`', () => {
    expectSymbolEdge(data, 'uses', CTRL, SVC);
    expectSymbolEdge(data, 'uses', SVC, REPO);
    expectSymbolEdge(data, 'uses', USER, 'src/users/enums/role.enum.ts#Role');
    expectSymbolEdge(data, 'uses', 'src/users/dto/create-user.dto.ts#CreateUserDto', 'src/users/enums/role.enum.ts#Role');
  });

  it('links classes to the DTO types of their method parameters with `uses`', () => {
    // create(@Body() dto: CreateUserDto) — the DTO is the request contract of the controller.
    expectSymbolEdge(data, 'uses', CTRL, 'src/users/dto/create-user.dto.ts#CreateUserDto');
    expectSymbolEdge(data, 'uses', SVC, 'src/users/dto/create-user.dto.ts#CreateUserDto');
  });
});

describe('nest-api: insights', () => {
  it('has no orphans, cycles or missing dependencies', () => {
    expect(data.insights.orphans).toEqual([]);
    expect(data.insights.cycles).toEqual([]);
    expect(data.insights.missingDependencies).toEqual([]);
  });

  it('counts imported Nest packages as used', () => {
    for (const name of ['@nestjs/common', '@nestjs/core', '@nestjs/mapped-types', 'class-validator', 'reflect-metadata']) {
      expect(data.insights.unusedDependencies, name).not.toContain(name);
    }
  });

  it('does not flag the implicitly loaded HTTP adapter @nestjs/platform-express as unused', () => {
    expect(data.insights.unusedDependencies).not.toContain('@nestjs/platform-express');
  });

  it('collects the TODO in the service', () => {
    expect(getFile(data, 'src/users/users.service.ts').todos).toEqual([
      { line: 37, tag: 'TODO', text: 'soft-delete instead and keep an audit trail' },
    ]);
  });
});
