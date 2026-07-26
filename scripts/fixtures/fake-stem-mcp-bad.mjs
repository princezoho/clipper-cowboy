#!/usr/bin/env node
process.stdin.once("data", () => {
  process.stdout.write("diagnostic on stdout is forbidden\n");
});
