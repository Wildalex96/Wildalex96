# Rehydrate the Spark source bundle used by Render and CI.
set -euo pipefail
mkdir -p spark
cat .spark-bundle/part* | base64 -d | xz -d | tar -x -C spark

# This app uses the Prisma 6 schema/client API. Prisma 7+ moved datasource
# connection URLs out of schema.prisma, so keep this project on 6.19.0.
node <<'NODE'
const fs = require("fs");
const schema = "spark/server/prisma/schema.prisma";
let s = fs.readFileSync(schema, "utf8");
s = s.replaceAll("\\n", "\n");
fs.writeFileSync(schema, s);

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
echo "Spark source restored; Prisma 6.19.0 pinned"
