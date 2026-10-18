import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { Role } from './enums/role.enum';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  findAll(role?: Role): Promise<User[]> {
    return role ? this.repo.findByRole(role) : this.repo.findAll();
  }

  async findOne(id: number): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }

  async create(dto: CreateUserDto): Promise<User> {
    const user = new User(dto.email, dto.name, dto.role ?? Role.Viewer);
    user.validate();
    return this.repo.save(user);
  }

  async update(id: number, dto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);
    Object.assign(user, dto);
    user.validate();
    return this.repo.save(user);
  }

  async remove(id: number): Promise<void> {
    const deleted = await this.repo.delete(id);
    // TODO: soft-delete instead and keep an audit trail
    if (!deleted) throw new NotFoundException(`User #${id} not found`);
  }
}
