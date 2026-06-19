import { DEFAULT_PORT } from "../core/shared";
import { startServer } from "../server/app";

startServer(DEFAULT_PORT)
  .then(() => {
    console.log(`Codex Artifacts listening on http://127.0.0.1:${DEFAULT_PORT}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
