"use strict";

const { createApp } = require("./app.cjs");

async function main() {
  const app = createApp();
  const address = await app.listen();
  console.log(`亲友录 API 已启动：http://${address.address}:${address.port}`);
  console.log(`持久化目录：${app.config.dataDir}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      try {
        await app.close();
        process.exitCode = 0;
      } catch {
        process.exitCode = 1;
      }
    });
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
