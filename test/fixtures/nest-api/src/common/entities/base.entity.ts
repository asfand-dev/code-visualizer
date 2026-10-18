import type { Identifiable } from '../interfaces/repository.interface';

export abstract class BaseEntity implements Identifiable {
  id = 0;
  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  abstract validate(): void;

  touch(): void {
    this.updatedAt = new Date();
  }
}
