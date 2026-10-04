"use strict";

const { ApiError } = require("../backend/dist/service.js");

/**
 * The web product is family-only. Keep archived classmate data in SQLite,
 * while presenting a family-scoped repository to every domain operation.
 * Scoping below the RPC dispatcher also covers aggregate queries, invite
 * tokens, indirect IDs, upload authorization and later photo rechecks.
 */
class FamilyRepository {
  constructor(store, { beforeWork, afterWork } = {}) {
    this.store = store;
    this.beforeWork = beforeWork;
    this.afterWork = afterWork;
  }

  atomic(work) {
    return this.store.atomic(
      async (source) => {
        const families = new Map();
        const isFamily = async (circleId) => {
          if (!families.has(circleId)) {
            const circle = await source.get("circles", circleId);
            families.set(circleId, circle?.type === "family");
          }
          return families.get(circleId);
        };
        const visible = async (collection, entity) => {
          if (!entity) return false;
          if (collection === "circles") return entity.type === "family";
          return entity.circleId === undefined || isFamily(entity.circleId);
        };
        const filter = async (collection, rows) => {
          const allowed = await Promise.all(
            rows.map((entity) => visible(collection, entity)),
          );
          return rows.filter((_, index) => allowed[index]);
        };
        const unit = {
          async get(collection, id) {
            const entity = await source.get(collection, id);
            return (await visible(collection, entity)) ? entity : undefined;
          },
          async find(collection, match) {
            if (
              match.circleId !== undefined &&
              !(await isFamily(match.circleId))
            )
              return [];
            return filter(collection, await source.find(collection, match));
          },
          async findByIds(collection, ids) {
            return filter(collection, await source.findByIds(collection, ids));
          },
          async put(collection, entity) {
            if (collection === "circles") {
              if (entity.type !== "family")
                throw new ApiError("WRONG_CIRCLE_TYPE", "这里只支持家庭记录");
              const previous = await source.get("circles", entity.id);
              if (previous && previous.type !== "family")
                throw new ApiError("NOT_FOUND", "家庭记录不存在");
            } else if (!(await visible(collection, entity))) {
              throw new ApiError("NOT_FOUND", "家庭记录不存在");
            }
            await source.put(collection, entity);
            if (collection === "circles") families.set(entity.id, true);
          },
          async delete(collection, id) {
            const entity = await source.get(collection, id);
            if (entity && !(await visible(collection, entity)))
              throw new ApiError("NOT_FOUND", "家庭记录不存在");
            await source.delete(collection, id);
            if (collection === "circles") families.set(id, false);
          },
        };
        const result = await work(unit);
        if (this.afterWork) await this.afterWork(unit, result);
        return result;
      },
      { familyOnlyFind: true, beforeWork: this.beforeWork },
    );
  }
}

module.exports = { FamilyRepository };
