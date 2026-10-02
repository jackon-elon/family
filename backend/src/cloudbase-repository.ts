import type { CollectionName, EntityMap } from './model';
import { QueryResultLimitError } from './repository';
import type { Repository, UnitOfWork } from './repository';

// Only the cloud function imports the SDK. This adapter accepts its database
// object so the domain service stays independent of CloudBase and AppID.
export class CloudBaseRepository implements Repository {
  constructor(private readonly db: any) {}

  async atomic<T>(work: (unit: UnitOfWork) => Promise<T>): Promise<T> {
    const transaction = await this.db.startTransaction();
    const unit: UnitOfWork = {
      get: async <K extends CollectionName>(collection: K, id: string) => {
        try {
          const result = await transaction.collection(collection).doc(id).get();
          return (result.data || undefined) as EntityMap[K] | undefined;
        } catch (error: any) {
          // Document-not-found is an expected lookup result. All other database
          // errors must reach the caller instead of weakening access checks.
          if (error?.code === 'DATABASE_DOCUMENT_NOT_EXIST' || error?.code === -502005 || /not exist|not found/i.test(String(error?.message ?? ''))) return undefined;
          throw error;
        }
      },
      find: async <K extends CollectionName>(collection: K, match: Partial<EntityMap[K]>) => {
        // CloudBase transactions permit doc(id) operations only. Collection
        // scans are used for lists; security-critical invitation, member and
        // person decisions also read their deterministic IDs in transaction.
        const all: EntityMap[K][] = [];
        const maxResults = 5000;
        for (let offset = 0; offset <= maxResults; offset += 100) {
          // Fetch one sentinel after the cap so a full page never silently
          // makes authorization/graph checks or list views incomplete.
          const limit = offset === maxResults ? 1 : 100;
          const result = await this.db.collection(collection).where(match).orderBy('_id', 'asc').skip(offset).limit(limit).get();
          const page = (result.data ?? []) as EntityMap[K][];
          if (offset === maxResults && page.length) throw new QueryResultLimitError(collection);
          all.push(...page);
          if (page.length < 100) break;
        }
        return all;
      },
      put: async <K extends CollectionName>(collection: K, entity: EntityMap[K]) => {
        await transaction.collection(collection).doc(entity.id).set({ data: entity });
      },
      delete: async <K extends CollectionName>(collection: K, id: string) => {
        const doc = transaction.collection(collection).doc(id);
        if (typeof doc.delete === 'function') await doc.delete();
        else await doc.remove();
      }
    };
    try {
      const result = await work(unit);
      await transaction.commit();
      return result;
    } catch (error) {
      try { await transaction.rollback(); } catch { /* transaction may already have ended */ }
      throw error;
    }
  }
}
