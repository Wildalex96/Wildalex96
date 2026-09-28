# Rehydrate the Spark source bundle used by Render and CI.
set -euo pipefail
mkdir -p spark
cat .spark-bundle/part* | base64 -d | xz -d | tar -x -C spark

# Normalize the archived compact Prisma schema to the Prisma 6 syntax used by
# the application, including the historical literal "\\n" sequence.
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
NODE

# Prisma 6.19 matches this application's schema/client API. Prisma 7+ moved
# datasource connection URLs out of schema.prisma.
node <<'NODE'
const fs = require("fs");
const path = "spark/server/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.devDependencies = pkg.devDependencies || {};
pkg.dependencies["@prisma/client"] = "6.19.0";
pkg.devDependencies.prisma = "6.19.0";
pkg.scripts = pkg.scripts || {};
pkg.scripts.build = "npx prisma@6.19.0 generate --schema=prisma/schema.prisma && tsc";
pkg.scripts.migrate = "npx prisma@6.19.0 migrate deploy --schema=prisma/schema.prisma";
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
NODE

rm -rf spark/server/node_modules
echo "Spark source restored; Prisma 6.19.0 pinned and schema normalized"
