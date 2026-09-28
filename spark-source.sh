# source bundle assembler placeholder
set -euo pipefail
mkdir -p spark
cat .spark-bundle/part* | base64 -d | xz -d | tar -x -C spark
 echo "Spark source restored"
