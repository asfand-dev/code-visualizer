import { BaseEntity } from '../../common/entities/base.entity';
import type { Auditable } from '../../common/interfaces/auditable.interface';
import { Role } from '../enums/role.enum';

export class User extends BaseEntity implements Auditable {
  createdBy?: string;
  updatedBy?: string;

  constructor(
    public email: string,
    public name: string,
    public role: Role = Role.Viewer,
  ) {
    super();
  }

  get isAdmin(): boolean {
    return this.role === Role.Admin;
  }

  validate(): void {
    if (!this.email.includes('@')) throw new Error(`Invalid email: ${this.email}`);
  }
}
