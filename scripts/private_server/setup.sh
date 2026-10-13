#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
server_dir="$project_root/private-server/server"

if [[ -x "$server_dir/bin/screeps.js" ]]; then
    echo "Screeps private server is already installed at $server_dir"
    exit 0
fi

if [[ -e "$server_dir" ]]; then
    echo "Refusing to overwrite incomplete path $server_dir" >&2
    exit 1
fi

mkdir -p "$(dirname "$server_dir")"
git clone --depth 1 https://github.com/screeps/screeps.git "$server_dir"
npm install --prefix "$server_dir"
echo "Screeps private server installed at $server_dir"
