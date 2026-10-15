// Child process used by the concurrency test: writes N memories into the same project.
// Usage: node concurrent-writer.mjs <distIndexPath> <projectDir> <workerId> <count>
const [, , distIndex, projectDir, workerId, count] = process.argv;
const { DevMemory } = await import(distIndex);
const dm = DevMemory.open();
const pm = dm.project(dm.projects.resolve(projectDir));
let created = 0;
for (let i = 0; i < Number(count); i++) {
  const r = pm.save({
    type: 'fact',
    title: `worker ${workerId} note ${i}`,
    content: `Concurrent write ${i} from worker ${workerId}`,
    tags: [`w${workerId}`],
  });
  if (r.status === 'created') created++;
  // One shared duplicate across all workers exercises the in-transaction duplicate check.
  pm.save({ type: 'fact', title: 'shared', content: 'identical content written by every worker' });
}
dm.close();
process.stdout.write(JSON.stringify({ workerId, created }));
