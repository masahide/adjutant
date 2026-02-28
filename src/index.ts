export function main(): void {
  process.stdout.write("adjutant rewrite bootstrap\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
