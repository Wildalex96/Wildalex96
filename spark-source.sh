# Rehydrate the Spark source bundle used by Render and CI.
set -euo pipefail
mkdir -p spark
cat .spark-bundle/part* | base64 -d | xz -d | tar -x -C spark

# Normalize archived sources for the current Node/TypeScript toolchain.
node <<'NODE'
const fs = require("fs");

const schema = "spark/server/prisma/schema.prisma";
let s = fs.readFileSync(schema, "utf8");
const replacements = new Map([
  ['generator client { provider = "prisma-client-js" }',
   'generator client {\n  provider = "prisma-client-js"\n}'],
  ['datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
   'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'],
  ['enum UserRole { USER MODERATOR ADMIN }',
   'enum UserRole {\n  USER\n  MODERATOR\n  ADMIN\n}'],
  ['enum PhotoStatus { PENDING APPROVED REJECTED }',
   'enum PhotoStatus {\n  PENDING\n  APPROVED\n  REJECTED\n}'],
  ['enum ReportStatus { OPEN REVIEWED DISMISSED ACTIONED }',
   'enum ReportStatus {\n  OPEN\n  REVIEWED\n  DISMISSED\n  ACTIONED\n}'],
  ['enum ReportReason { SPAM HARASSMENT INAPPROPRIATE FAKE SCAM OTHER }',
   'enum ReportReason {\n  SPAM\n  HARASSMENT\n  INAPPROPRIATE\n  FAKE\n  SCAM\n  OTHER\n}']
]);
for (const [from, to] of replacements) s = s.replace(from, to);
s = s.replaceAll("\\n", "\n");
fs.writeFileSync(schema, s);

const tsconfigPath = "spark/server/tsconfig.json";
const ts = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
ts.compilerOptions = ts.compilerOptions || {};
ts.compilerOptions.module = "NodeNext";
ts.compilerOptions.moduleResolution = "NodeNext";
ts.compilerOptions.rootDir = "./src";
fs.writeFileSync(tsconfigPath, JSON.stringify(ts, null, 2) + "\n");

for (const path of ["spark/server/src/index.ts", "spark/server/src/worker.ts"]) {
  let c = fs.readFileSync(path, "utf8");
  c = c.replaceAll('import IORedis from "ioredis";', 'import { Redis as IORedis } from "ioredis";');
  c = c.replaceAll('import { default as IORedis } from "ioredis";', 'import { Redis as IORedis } from "ioredis";');
  fs.writeFileSync(path, c);
}

const pkgPath = "spark/server/package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.devDependencies = pkg.devDependencies || {};
pkg.dependencies["dotenv"] = "18.0.4";
pkg.dependencies["@prisma/client"] = "6.19.0";
pkg.devDependencies.prisma = "6.19.0";
pkg.scripts = pkg.scripts || {};
pkg.scripts.build = "npx prisma@6.19.0 generate --schema=prisma/schema.prisma && tsc";
pkg.scripts.migrate = "npx prisma@6.19.0 migrate deploy --schema=prisma/schema.prisma";
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
NODE

echo "Spark source restored; Prisma 6.19.0, NodeNext, ioredis named export, dotenv 18.0.4"
