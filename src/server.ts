import { DEFAULT_PORT } from "./shared";
import { startServer } from "./app";

startServer(DEFAULT_PORT)
  .then(() => {
    console.log(`Codex Artifacts listening on http://127.0.0.1:${DEFAULT_PORT}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
