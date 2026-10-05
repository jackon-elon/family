"use strict";

const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { QueryResultLimitError } = require("../backend/dist/repository.js");

const collections = new Set([
  "circles",
  "members",
  "persons",
  "relations",
  "invites",
  "applications",
  "delegations",
  "suggestions",
  "claimRequests",
  "audit",
  "photoUploadBudgets",
  "phoneMatches",
  "phoneIdentities",
  "userProfiles",
  "personRemarks",
]);

// Literal paths match SQLite expression indexes. Only these fixed paths are
// interpolated; arbitrary keys and all values remain bound parameters.
function documentMatchConditions(collection, match) {
  const clauses = ["collection = ?"],
    values = [collection];
  const indexed = {
    circleId: "json_extract(body, '$.circleId')",
    userId: "json_extract(body, '$.userId')",
  };
  for (const [key, value] of Object.entries(match)) {
    if (
      !/^[A-Za-z][A-Za-z0-9]*$/.test(key) ||
      (value !== null &&
        value !== undefined &&
        !["string", "number", "boolean"].includes(typeof value))
    )
      throw new Error("Invalid query");
    if (Object.hasOwn(indexed, key)) clauses.push(`${indexed[key]} IS ?`);
    else {
      clauses.push("json_extract(body, ?) IS ?");
      values.push(`$.${key}`);
    }
    values.push(
      value === undefined
        ? null
        : typeof value === "boolean"
          ? Number(value)
          : value,
    );
  }
  return { clauses, values };
}

/** One shared queue covers domain transactions and authentication writes. */
class SqliteStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "kin.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)),
        PRIMARY KEY(collection, id)
      );
      CREATE INDEX IF NOT EXISTS document_circle ON documents(collection, json_extract(body, '$.circleId'));
      CREATE INDEX IF NOT EXISTS document_user ON documents(collection, json_extract(body, '$.userId'));
      CREATE INDEX IF NOT EXISTS document_circle_order ON documents(collection, json_extract(body, '$.circleId'), id);
      CREATE INDEX IF NOT EXISTS document_user_order ON documents(collection, json_extract(body, '$.userId'), id);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_account ON sessions(account_id);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_limit_expiry ON rate_limits(expires_at);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invite_accounts (
        invite_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS invite_account_account ON invite_accounts(account_id);
      CREATE TABLE IF NOT EXISTS invite_profile_imports (
        invite_id TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL, person_updated_at INTEGER NOT NULL, imported_fields TEXT,
        PRIMARY KEY(invite_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS guest_sessions (
        token_hash TEXT PRIMARY KEY, circle_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guest_session_expiry ON guest_sessions(expires_at);
    `);
    // Migrate in place without changing existing absolute expiry dates.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        !this.db
          .prepare("PRAGMA table_info(invite_profile_imports)")
          .all()
          .some((column) => column.name === "imported_fields")
      )
        this.db.exec(
          "ALTER TABLE invite_profile_imports ADD COLUMN imported_fields TEXT",
        );
      const columns = new Set(
        this.db
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .map((row) => row.name),
      );
      for (const [name, definition] of [
        ["public_id", "TEXT"],
        ["device_name", "TEXT NOT NULL DEFAULT '旧版浏览器'"],
        ["last_seen_at", "INTEGER"],
        ["reauthenticated_at", "INTEGER NOT NULL DEFAULT 0"],
        ["remembered", "INTEGER NOT NULL DEFAULT 0"],
      ])
        if (!columns.has(name))
          this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      for (const row of this.db
        .prepare(
          "SELECT token_hash, created_at FROM sessions WHERE public_id IS NULL",
        )
        .all())
        this.db
          .prepare(
            "UPDATE sessions SET public_id = ?, last_seen_at = COALESCE(last_seen_at, created_at) WHERE token_hash = ?",
          )
          .run(crypto.randomUUID(), row.token_hash);
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS session_public_id ON sessions(public_id)",
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
    this.tail = Promise.resolve();
    this.closed = false;
  }

  exclusive(work) {
    if (this.closed) return Promise.reject(new Error("Database is closed"));
    const result = this.tail.then(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = await work(this.db);
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  atomic(work, { familyOnlyFind = false, beforeWork } = {}) {
    return this.exclusive(async (db) => {
      if (beforeWork) await beforeWork(db);
      let active = true;
      const validate = (collection) => {
        if (!active || !collections.has(collection))
          throw new Error("Invalid document access");
      };
      const get = async (collection, id) => {
        validate(collection);
        const row = db
          .prepare("SELECT body FROM documents WHERE collection = ? AND id = ?")
          .get(collection, id);
        return row ? JSON.parse(row.body) : undefined;
      };
      const unit = {
        get,
        find: async (collection, match) => {
          validate(collection);
          const { clauses, values } = documentMatchConditions(
            collection,
            match,
          );
          // Apply the web product scope in SQL, before the result cap. Archived
          // classmate rows must not consume a family query's pagination/budget.
          if (familyOnlyFind)
            clauses.push(`(
              (collection = 'circles' AND json_extract(body, '$.type') = 'family')
              OR (collection <> 'circles' AND (
                json_type(body, '$.circleId') IS NULL
                OR EXISTS (
                  SELECT 1 FROM documents AS circle_scope
                  WHERE circle_scope.collection = 'circles'
                    AND circle_scope.id = json_extract(documents.body, '$.circleId')
                    AND json_extract(circle_scope.body, '$.type') = 'family'
                )
              ))
            )`);
          const rows = db
            .prepare(
              `SELECT body FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT 5001`,
            )
            .all(...values);
          if (rows.length > 5000) throw new QueryResultLimitError(collection);
          return rows.map((row) => JSON.parse(row.body));
        },
        findByIds: async (collection, ids) => {
          validate(collection);
          const unique = [...new Set(ids)];
          if (unique.length > 5000) throw new QueryResultLimitError(collection);
          return (
            await Promise.all(unique.map((id) => get(collection, id)))
          ).filter(Boolean);
        },
        put: async (collection, entity) => {
          validate(collection);
          if (!entity || typeof entity.id !== "string")
            throw new Error("Missing document ID");
          db.prepare(
            "INSERT INTO documents(collection, id, body) VALUES(?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body",
          ).run(collection, entity.id, JSON.stringify(entity));
        },
        delete: async (collection, id) => {
          validate(collection);
          db.prepare(
            "DELETE FROM documents WHERE collection = ? AND id = ?",
          ).run(collection, id);
        },
      };
      try {
        return await work(unit);
      } finally {
        active = false;
      }
    });
  }

  async close() {
    this.closed = true;
    await this.tail;
    this.db.close();
  }
}

module.exports = { SqliteStore, documentMatchConditions };
