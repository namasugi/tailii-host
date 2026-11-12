/** 順序を保ち、ファイル記述子と I/O キューを増やしすぎずに非同期読み取りを行う。 */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  read: (value: T) => Promise<R>,
  concurrency = 32,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      result[index] = await read(values[index]!);
    }
  }));
  return result;
}
