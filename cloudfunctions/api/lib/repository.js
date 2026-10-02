"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryResultLimitError = void 0;
class QueryResultLimitError extends Error {
    collection;
    constructor(collection) {
        super(`Query result limit exceeded: ${collection}`);
        this.collection = collection;
    }
}
exports.QueryResultLimitError = QueryResultLimitError;
