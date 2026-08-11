export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">rageflow</h1>
      <p className="text-sm opacity-80">
        Scaffold only. The prediction engine lives in <code>src/engine</code> and is covered by
        tests. The logging and prediction UI arrives in task 2.
      </p>
      <p className="text-xs opacity-60">Not contraception, and not medical advice.</p>
    </main>
  );
}
