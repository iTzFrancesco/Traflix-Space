export function invokeWithTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout dopo ${ms}ms`)), ms),
    ),
  ]);
}
