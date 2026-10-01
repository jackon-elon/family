"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CloudBaseRepository = void 0;
// Only the cloud function imports the SDK. This adapter accepts its database
// object so the domain service stays independent of CloudBase and AppID.
class CloudBaseRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async atomic(work) {
        const transaction = await this.db.startTransaction();
        const unit = {
            get: async (collection, id) => {
                try {
                    const result = await transaction.collection(collection).doc(id).get();
                    return (result.data || undefined);
                }
                catch (error) {
                    // Document-not-found is an expected lookup result. All other database
                    // errors must reach the caller instead of weakening access checks.
                    if (error?.code === 'DATABASE_DOCUMENT_NOT_EXIST' || error?.code === -502005 || /not exist|not found/i.test(String(error?.message ?? '')))
                        return undefined;
                    throw error;
                }
            },
            find: async (collection, match) => {
                // CloudBase transactions permit doc(id) operations only. Collection
                // scans are used for lists; security-critical invitation, member and
                // person decisions also read their deterministic IDs in transaction.
                const all = [];
                for (let offset = 0; offset < 5000; offset += 100) {
                    const result = await this.db.collection(collection).where(match).orderBy('_id', 'asc').skip(offset).limit(100).get();
                    const page = (result.data ?? []);
                    all.push(...page);
                    if (page.length < 100)
                        break;
                }
                return all;
            },
            put: async (collection, entity) => {
                await transaction.collection(collection).doc(entity.id).set({ data: entity });
            },
            delete: async (collection, id) => {
                const doc = transaction.collection(collection).doc(id);
                if (typeof doc.delete === 'function')
                    await doc.delete();
                else
                    await doc.remove();
            }
        };
        try {
            const result = await work(unit);
            await transaction.commit();
            return result;
        }
        catch (error) {
            try {
                await transaction.rollback();
            }
            catch { /* transaction may already have ended */ }
            throw error;
        }
    }
}
exports.CloudBaseRepository = CloudBaseRepository;
