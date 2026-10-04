"use strict";

const crypto = require("node:crypto");
const readline = require("node:readline");
const { createInterface } = require("node:readline/promises");
const { readConfig } = require("./config.cjs");
const { SqliteStore } = require("./store.cjs");
const { normalizePhone, passwordHash } = require("./auth.cjs");

/** Trusted local initialization only. Never expose this function as an HTTP route. */
async function setupFamily({ env = process.env, phone, password, familyName }) {
  const normalizedPhone = normalizePhone(phone);
  if (
    typeof familyName !== "string" ||
    !familyName.trim() ||
    familyName.trim().length > 60
  )
    throw new Error("家人录名称须为 1–60 个字符。");
  const config = readConfig(env);
  const store = new SqliteStore(config.dataDir);
  try {
    const saved = await passwordHash(password);
    return await store.exclusive((db) => {
      if (
        db.prepare("SELECT COUNT(*) AS total FROM accounts").get().total ||
        db.prepare("SELECT COUNT(*) AS total FROM documents").get().total
      )
        throw new Error("只能初始化空数据库；现有账号和家人资料已保留。");
      const now = Date.now();
      const accountId = `web_${crypto.randomUUID()}`;
      const familyId = crypto.randomUUID();
      const memberId = `${familyId}_${crypto.createHash("sha256").update(accountId).digest("hex").slice(0, 40)}`;
      db.prepare(
        "INSERT INTO accounts(id, phone, password_hash, created_at) VALUES(?, ?, ?, ?)",
      ).run(accountId, normalizedPhone, saved, now);
      const put = (collection, value) =>
        db
          .prepare(
            "INSERT INTO documents(collection, id, body) VALUES(?, ?, ?)",
          )
          .run(collection, value.id, JSON.stringify(value));
      put("circles", {
        id: familyId,
        type: "family",
        name: familyName.trim(),
        mode: "shared",
        ownerId: accountId,
        createdBy: accountId,
        createdAt: now,
        updatedAt: now,
      });
      put("members", {
        id: memberId,
        circleId: familyId,
        userId: accountId,
        name: "创建者",
        role: "owner",
        status: "active",
        joinedAt: now,
      });
      put("audit", {
        id: crypto.randomUUID(),
        circleId: familyId,
        actorId: accountId,
        type: "circle.create",
        targetId: familyId,
        at: now,
        details: { source: "local-setup" },
      });
      return { familyId, accountId, phone: normalizedPhone };
    });
  } finally {
    await store.close();
  }
}

function secret(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    process.stdout.write(question);
    let value = "";
    const finish = (error) => {
      input.removeListener("keypress", onKey);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write("\n");
      error ? reject(error) : resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c")
        return finish(new Error("已取消初始化。"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text))
        value += text;
    };
    input.on("keypress", onKey);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "请在交互终端运行初始化命令；密码不接受命令行参数或管道输入。",
    );
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let phone, familyName;
  try {
    phone = await prompt.question("管理员手机号：");
    familyName = await prompt.question("家人录名称：");
  } finally {
    prompt.close();
  }
  const password = await secret(
    "管理员密码（10–128 位，含字母和数字，输入隐藏）：",
  );
  const confirmation = await secret("再次输入密码：");
  if (password !== confirmation) throw new Error("两次密码不一致，未初始化。");
  await setupFamily({ phone, password, familyName });
  console.log("家庭已初始化。请登录网页，在“我的”补齐资料，然后邀请家人。");
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { setupFamily };
