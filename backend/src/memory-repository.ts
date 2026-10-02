import type { CollectionName, EntityMap } from './model';
import type { Repository, UnitOfWork } from './repository';

const names: CollectionName[] = ['circles', 'members', 'persons', 'relations', 'invites', 'applications', 'delegations', 'suggestions', 'claimRequests', 'audit', 'photoUploadBudgets'];

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

export class MemoryRepository implements Repository {
  private data: Record<CollectionName, Map<string, unknown>> = Object.fromEntries(names.map(name => [name, new Map()])) as Record<CollectionName, Map<string, unknown>>;
  private tail: Promise<void> = Promise.resolve();

  async atomic<T>(work: (unit: UnitOfWork) => Promise<T>): Promise<T> {
    let unlock!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    const draft = Object.fromEntries(names.map(name => [name, new Map(this.data[name])])) as typeof this.data;
    const unit: UnitOfWork = {
      get: async <K extends CollectionName>(collection: K, id: string) => {
        const value = draft[collection].get(id);
        return value === undefined ? undefined : clone(value) as EntityMap[K];
      },
      find: async <K extends CollectionName>(collection: K, match: Partial<EntityMap[K]>) => {
        return [...draft[collection].values()].filter(value => Object.entries(match).every(([key, expected]) => (value as Record<string, unknown>)[key] === expected)).map(value => clone(value) as EntityMap[K]);
      },
      put: async <K extends CollectionName>(collection: K, entity: EntityMap[K]) => { draft[collection].set(entity.id, clone(entity)); },
      delete: async <K extends CollectionName>(collection: K, id: string) => { draft[collection].delete(id); }
    };
    try {
      const result = await work(unit);
      this.data = draft;
      return result;
    } finally {
      unlock();
    }
  }
}
