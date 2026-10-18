import { Injectable } from '@nestjs/common';
import type { Repository } from '../common/interfaces/repository.interface';
import { User } from './entities/user.entity';
import { Role } from './enums/role.enum';

@Injectable()
export class UsersRepository implements Repository<User> {
  private readonly users = new Map<number, User>();
  private sequence = 1;

  async findAll(): Promise<User[]> {
    return [...this.users.values()];
  }

  async findById(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async findByRole(role: Role): Promise<User[]> {
    return [...this.users.values()].filter((u) => u.role === role);
  }

  async save(entity: User): Promise<User> {
    if (!entity.id) entity.id = this.sequence++;
    entity.touch();
    this.users.set(entity.id, entity);
    return entity;
  }

  async delete(id: number): Promise<boolean> {
    return this.users.delete(id);
  }
}
