import type { CollectionName, EntityMap } from './model';

export class QueryResultLimitError extends Error {
  constructor(public readonly collection: CollectionName) {
    super(`Query result limit exceeded: ${collection}`);
  }
}

export interface UnitOfWork {
  get<K extends CollectionName>(collection: K, id: string): Promise<EntityMap[K] | undefined>;
  find<K extends CollectionName>(collection: K, match: Partial<EntityMap[K]>): Promise<EntityMap[K][]>;
  // A bounded read-only query outside the CloudBase document transaction.
  // Callers must derive IDs from authorized records, and recheck access before returning.
  findByIds<K extends CollectionName>(collection: K, ids: string[]): Promise<EntityMap[K][]>;
  put<K extends CollectionName>(collection: K, entity: EntityMap[K]): Promise<void>;
  delete<K extends CollectionName>(collection: K, id: string): Promise<void>;
}

export interface Repository {
  atomic<T>(work: (unit: UnitOfWork) => Promise<T>): Promise<T>;
}
