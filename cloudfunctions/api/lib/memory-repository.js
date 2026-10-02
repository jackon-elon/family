"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryRepository = void 0;
const names = ['circles', 'members', 'persons', 'relations', 'invites', 'applications', 'delegations', 'suggestions', 'claimRequests', 'audit', 'photoUploadBudgets'];
function clone(value) { return JSON.parse(JSON.stringify(value)); }
class MemoryRepository {
    data = Object.fromEntries(names.map(name => [name, new Map()]));
    tail = Promise.resolve();
    async atomic(work) {
        let unlock;
        const previous = this.tail;
        this.tail = new Promise(resolve => { unlock = resolve; });
        await previous;
        const draft = Object.fromEntries(names.map(name => [name, new Map(this.data[name])]));
        const unit = {
            get: async (collection, id) => {
                const value = draft[collection].get(id);
                return value === undefined ? undefined : clone(value);
            },
            find: async (collection, match) => {
                return [...draft[collection].values()].filter(value => Object.entries(match).every(([key, expected]) => value[key] === expected)).map(value => clone(value));
            },
            put: async (collection, entity) => { draft[collection].set(entity.id, clone(entity)); },
            delete: async (collection, id) => { draft[collection].delete(id); }
        };
        try {
            const result = await work(unit);
            this.data = draft;
            return result;
        }
        finally {
            unlock();
        }
    }
}
exports.MemoryRepository = MemoryRepository;
