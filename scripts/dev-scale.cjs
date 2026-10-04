// Disposable local acceptance family; never opens the normal data directory.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createApp } = require("../server/app.cjs");
const { seedScale } = require("./family-scale-fixture.cjs");

async function main() {
  if (process.env.NODE_ENV === "production")
    throw new Error("This fixture is for local testing only.");
  const root = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kin-scale-"));
  const url = "http://127.0.0.1:5175";
  const env = {
    ...process.env,
    NODE_ENV: "development",
    DATA_DIR: directory,
    FRONTEND_ORIGIN: url,
  };
  const app = createApp({ env });
  let web;
  const stop = async () => {
    await web?.close();
    await app.close();
  };
  try {
    const meta = await seedScale(app, env);
    const address = await app.listen(0, "127.0.0.1");
    const { createServer } = await import(
      pathToFileURL(path.join(root, "node_modules/vite/dist/node/index.js"))
        .href
    );
    web = await createServer({
      configFile: path.join(root, "frontend/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 5175,
        strictPort: true,
        proxy: {
          "/api": {
            target: `http://127.0.0.1:${address.port}`,
            changeOrigin: true,
          },
        },
      },
    });
    await web.listen();
    console.log(
      `四代百人验收家庭（虚构资料）\n${url}\n管理员：${meta.ownerPhone}\n普通成员：${meta.memberPhone}\n测试密码：${meta.password}\n临时数据：${directory}\nCtrl+C 停止。每次启动创建独立的新测试家庭。`,
    );
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  } catch (error) {
    await stop();
    throw error;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
