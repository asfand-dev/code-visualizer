export interface Identifiable {
  id: number;
}

/** Minimal persistence contract shared by all repositories. */
export interface Repository<T extends Identifiable> {
  findAll(): Promise<T[]>;
  findById(id: number): Promise<T | undefined>;
  save(entity: T): Promise<T>;
  delete(id: number): Promise<boolean>;
}
