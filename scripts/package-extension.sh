#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p "require('$project_dir/extension/manifest.json').version")
output_dir="$project_dir/dist"
output_file="$output_dir/JobDeck-Chrome-Extension-v$version.zip"
staging_dir=$(mktemp -d)

trap 'rm -rf "$staging_dir"' EXIT
mkdir -p "$output_dir" "$staging_dir/JobDeck-Chrome-Extension"
cp -R "$project_dir/extension/." "$staging_dir/JobDeck-Chrome-Extension/"
rm -f "$output_file"
(cd "$staging_dir" && zip -q -r -X "$output_file" JobDeck-Chrome-Extension)

printf '%s\n' "$output_file"
