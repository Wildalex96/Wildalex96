# Rehydrate the Spark source bundle used by Render and CI.
set -euo pipefail
mkdir -p spark
cat .spark-bundle/part* | base64 -d | xz -d | tar -x -C spark

# Normalize the Prisma 7 schema because the archived project used compact one-line
# top-level blocks and one literal "\\n" escape that newer Prisma parsers reject.
node <<'NODE'
const fs = require("fs");
const path = "spark/server/prisma/schema.prisma";
let s = fs.readFileSync(path, "utf8");
s = s.replace(/\\\\n/g, "\n");
s = s.replace(
  /^generator client \{ provider = "prisma-client-js" \}$/m,
  'generator client {\n  provider = "prisma-client-js"\n}'
);
s = s.replace(
  /^datasource db \{ provider = "postgresql" url = env\("DATABASE_URL"\) \}$/m,
  'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}'
);
const enums = {
  "UserRole": ["USER", "MODERATOR", "ADMIN"],
  "PhotoStatus": ["PENDING", "APPROVED", "REJECTED"],
  "ReportStatus": ["OPEN", "REVIEWED", "DISMISSED", "ACTIONED"],
  "ReportReason": ["SPAM", "HARASSMENT", "INAPPROPRIATE", "FAKE", "SCAM", "OTHER"]
};
for (const [name, values] of Object.entries(enums)) {
  const re = new RegExp('^enum ' + name + ' \\{[^}]*\\}$', 'm');
  s = s.replace(re, 'enum ' + name + ' {\n' + values.map(v => '  ' + v).join('\n') + '\n}');
}
fs.writeFileSync(path, s);
NODE

# The project uses Prisma ORM 7 APIs. Prisma ORM 8 is the current "latest"
# and removed the schema-driven generate/migrate commands used by this app.
node <<'NODE'
const fs = require("fs");
const path = "spark/server/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.devDependencies = pkg.devDependencies || {};
pkg.dependencies["@prisma/client"] = "^7.10.0";
pkg.devDependencies.prisma = "^7.10.0";
pkg.scripts = pkg.scripts || {};
pkg.scripts.build = "npx prisma@7.10.0 generate --schema=prisma/schema.prisma && tsc";
pkg.scripts.migrate = "npx prisma@7.10.0 migrate deploy --schema=prisma/schema.prisma";
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
NODE

rm -rf spark/server/node_modules
echo "Spark source restored; Prisma 7.10.x pinned and schema normalized"
