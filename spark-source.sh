# Rehydrate the Spark source bundle used by Render and CI.
set -euo pipefail
mkdir -p spark
cat .spark-bundle/part* | base64 -d | xz -d | tar -x -C spark

# The project uses Prisma ORM 7 APIs; Prisma 8 is currently the "latest"
# and intentionally removed schema-driven generate/migrate commands.
node <<'NODE'
const fs = require("fs");
const path = "spark/server/package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.devDependencies = pkg.devDependencies || {};
pkg.dependencies["@prisma/client"] = "^7.10.0";
pkg.devDependencies.prisma = "^7.10.0";
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
NODE

rm -rf spark/server/node_modules
echo "Spark source restored; Prisma deps pinned to 7.10.x"
