// A first-in-first-out queue per key: the tasks that share a key run one after another, in the order they arrive, so a rule that
// reads and then writes never sees the half-done work of another. A task that fails does not hold up the ones behind it.

export function createSerializer() {
  const tails = new Map(); // key -> the promise that settles when its last queued task is done

  return function serial(key, task) {
    const run = (tails.get(key) ?? Promise.resolve()).then(() => task());
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key); // nothing else queued behind it: forget the key
    });
    return run;
  };
}
