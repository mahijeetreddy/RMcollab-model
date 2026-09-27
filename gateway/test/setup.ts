import os from "node:os";
import path from "node:path";

process.env.STORAGE_ROOT = path.join(os.tmpdir(), "rmcollab-gateway-test-storage");
process.env.FILE_SIGNING_SECRET = "test-file-signing-secret";
process.env.FILE_URL_TTL_SECONDS = "3600";
process.env.PUBLIC_BASE_URL = "http://gateway.test";
process.env.WEBHOOK_ALLOW_PRIVATE_URLS = "false";
